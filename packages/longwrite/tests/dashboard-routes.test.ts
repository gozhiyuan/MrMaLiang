import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browseWorkspaceFolders, buildResearchProjection, dashboardRunInvocation, detachedDashboardRunOptions, evidenceProgramFingerprint, resolveWritingWorkspace, updateManifestStage } from "../dashboard-extension/server/routes.js";

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
  it("projects the current compact evidence and corpus-gate artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "maliang-dashboard-projection-"));
    temporaryDirs.push(root);
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await fs.mkdir(path.join(root, "reports"), { recursive: true });
    await fs.mkdir(path.join(root, "sources"), { recursive: true });
    await fs.mkdir(path.join(root, "chapters"), { recursive: true });
    await fs.mkdir(path.join(root, "build"), { recursive: true });
    await fs.writeFile(path.join(root, "evidence", "coverage.json"), JSON.stringify({
      taxonomy: [{ cell: "harnesses", source_count: 12 }],
    }), "utf-8");
    await fs.writeFile(path.join(root, "reports", "corpus-gates.json"), JSON.stringify({
      pass: true, source_count: 24, findings: [{ id: "core_sources", detail: "24 A/B-depth core sources; required 20" }],
    }), "utf-8");
    await fs.writeFile(path.join(root, "reports", "metrics.json"), JSON.stringify({ corpus_gate_pass: 1, outline_readiness: 1 }), "utf-8");
    await fs.writeFile(path.join(root, "outline.json"), JSON.stringify({
      sections: [{ id: "section-001", title: "Opening", target_words: 400, source_ids: ["a", "b"] }, { id: "section-002", target_words: 500 }],
    }), "utf-8");
    await fs.writeFile(path.join(root, "longwrite.yaml"), "writing:\n  target_length_words: 1200\n", "utf-8");
    await fs.writeFile(path.join(root, "reports", "latex-build.md"), "- Engine: tectonic\n\n- warning: one\n- warning: two\n", "utf-8");
    await fs.writeFile(path.join(root, "chapters", "section-001.md"), "A completed chapter has four words.", "utf-8");
    await fs.writeFile(path.join(root, "build", "manuscript.pdf"), "%PDF-1.7\n", "utf-8");
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), [
      JSON.stringify({ id: "a", citation_depth: "A" }),
      JSON.stringify({ id: "b", citation_depth: "B" }),
      JSON.stringify({ id: "c", citation_depth: "C" }),
    ].join("\n"), "utf-8");

    const projection = await buildResearchProjection(root);
    expect(projection.phase).toBe("pre_draft");
    expect(projection.evidence).toMatchObject({ sources: 24, coverage: { harnesses: 12 }, depth: { A: 1, B: 1, C: 1 } });
    expect(projection.manuscript.chapters).toEqual([
      { id: "section-001", title: "Opening", words: 6, targetWords: 400, sourceCount: 2, state: "drafted" },
      { id: "section-002", title: undefined, words: 0, targetWords: 500, sourceCount: 0, state: "pending" },
    ]);
    expect(projection.manuscript).toMatchObject({ draftTargetWords: 900, projectTargetWords: 1200, pdf: { status: "compiled", warningCount: 2 } });
    expect(projection.release.gates.find((gate) => gate.id === "corpus_gate_pass")).toMatchObject({
      status: "passed", detail: "24 A/B-depth core sources; required 20",
    });
  });

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

describe("MrMaLiang dashboard run invocation", () => {
  it("detaches dashboard-started runs and writes their output to durable file descriptors", () => {
    expect(detachedDashboardRunOptions("/workspace", 42)).toEqual({
      cwd: "/workspace",
      shell: false,
      detached: true,
      stdio: ["ignore", 42, 42],
    });
  });

  it("uses the public Maliang lifecycle when resetting a parent workspace", () => {
    expect(dashboardRunInvocation("/workspace/writing", "/workspace", { runtime: "codex", reset: true })).toEqual({
      command: "maliang",
      args: ["run", "/workspace", "--runtime", "codex", "--reset"],
      cwd: "/workspace",
    });
  });

  it("uses the public Maliang lifecycle for a normal parent-workspace run", () => {
    expect(dashboardRunInvocation("/workspace/writing", "/workspace", { runtime: "codex" })).toEqual({
      command: "maliang",
      args: ["run", "/workspace", "--runtime", "codex"],
      cwd: "/workspace",
    });
  });
});
