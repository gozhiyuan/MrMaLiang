import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browseWorkspaceFolders, evidenceProgramFingerprint, resolveWritingWorkspace, updateManifestStage } from "../dashboard-extension/server/routes.js";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function manifest() {
  return {
    workflow: {
      model_tiers: { cheap: { runtime: "codex" } },
      stages: [
        { id: "outline", owner: "lead", outputs: ["outline.md"] },
        {
          type: "foreach", id: "draft_sections", foreach: "outline.sections", max_parallel: 2,
          steps: [{ id: "draft", owner: "writer", outputs: ["chapters/{{item.id}}.md"] }],
        },
        { type: "loop", id: "quality", max_rounds: 2, stages: [{ id: "review", owner: "reviewer", outputs: ["review.md"] }] },
      ],
    },
  };
}

describe("dashboard workflow stage patches", () => {
  it("rejects execution edits on foreach and loop parents", () => {
    expect(() => updateManifestStage(manifest(), { stageId: "draft_sections", runtime: "codex" }))
      .toThrow(/foreach group/);
    expect(() => updateManifestStage(manifest(), { stageId: "quality", modelTier: "cheap" }))
      .toThrow(/loop group/);
  });

  it("allows only a valid foreach max_parallel patch", () => {
    const value = manifest();
    updateManifestStage(value, { stageId: "draft_sections", maxParallel: 4 });
    expect((value.workflow.stages[1] as { max_parallel: number }).max_parallel).toBe(4);
  });
});

describe("MrMaLiang dashboard workspace selection", () => {
  it("opens a public parent workspace by resolving its writing component", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "maliang-dashboard-"));
    temporaryDirs.push(root);
    const program = path.join(root, "repository-survey");
    const writing = path.join(program, "writing");
    await fs.mkdir(writing, { recursive: true });
    await fs.writeFile(path.join(program, "maliang.yaml"), "components:\n  writing:\n    workspace: writing\n", "utf-8");
    await fs.writeFile(path.join(writing, "longwrite.yaml"), "version: 1\n", "utf-8");

    await expect(resolveWritingWorkspace(program)).resolves.toEqual({
      requestedDir: program,
      workspaceDir: writing,
      parentWorkspace: program,
    });
  });

  it("lists only folders and marks selectable program and writing workspaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "maliang-dashboard-browse-"));
    temporaryDirs.push(root);
    const program = path.join(root, "program");
    const writing = path.join(root, "writing-only");
    await fs.mkdir(path.join(program, "writing"), { recursive: true });
    await fs.mkdir(writing, { recursive: true });
    await fs.writeFile(path.join(program, "maliang.yaml"), "components:\n  writing:\n    workspace: writing\n", "utf-8");
    await fs.writeFile(path.join(writing, "longwrite.yaml"), "version: 1\n", "utf-8");
    await fs.writeFile(path.join(root, "private.env"), "must not be listed", "utf-8");

    const result = await browseWorkspaceFolders(root, root);
    expect(result.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "program", kind: "maliang_workspace" }),
      expect.objectContaining({ name: "writing-only", kind: "writing_workspace" }),
    ]));
    expect(result.folders.map((entry) => entry.name)).not.toContain("private.env");
  });

  it("treats topic, codebase revisions, and reference links as evidence-program inputs", () => {
    const base = {
      research: { topic: "Agentic research", codebases: [{ id: "repo-demo", source: "https://github.com/example/demo.git", ref: "main", role: "primary_artifact" }] },
      writing: { reference_links: ["https://arxiv.org/abs/2401.00001"] },
    };
    expect(evidenceProgramFingerprint(base)).not.toBe(evidenceProgramFingerprint({
      ...base,
      research: { ...base.research, codebases: [{ ...base.research.codebases[0], ref: "v1.0.0" }] },
    }));
    expect(evidenceProgramFingerprint(base)).not.toBe(evidenceProgramFingerprint({
      ...base,
      writing: { reference_links: ["https://doi.org/10.1000/example"] },
    }));
  });
});
