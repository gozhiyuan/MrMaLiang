import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadMode } from "../src/lib/modes.js";
import { scaffoldWorkspace } from "../src/lib/scaffold.js";

const tempDirs: string[] = [];

async function makeWorkspaceRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-ws-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.LONGWRITE_TEMPLATES_DIR;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("scaffoldWorkspace", () => {
  it("creates a self-contained workspace", async () => {
    process.env.LONGWRITE_TEMPLATES_DIR = path.resolve("templates");
    const root = await makeWorkspaceRoot();
    const target = path.join(root, "survey");
    const mode = await loadMode("auto_research_agentic");
    const created = await scaffoldWorkspace({
      mode,
      targetDir: target,
      projectId: "survey",
      projectName: "Survey",
      authors: [{ name: "Ada Lovelace", email: "ada@example.com" }],
      topic: "Long-horizon agent memory",
      researchProvider: "semantic_scholar",
      reviewCadence: "daily",
      reviewTime: "08:00",
      reviewIntervalHours: 6,
      batchApprovals: true,
    });

    expect(created).toContain("malaclaw.yaml");
    expect(created).toContain(".env.example");
    expect(created).toContain(".gitignore");
    expect(await fs.readFile(path.join(target, ".env.example"), "utf-8")).toContain("OPENALEX_API_KEY=");
    expect(await fs.readFile(path.join(target, ".gitignore"), "utf-8")).toContain(".env");
    for (const dir of ["sources", "notes", "bibles", "outline", "chapters", "examples", "reviews", "reports", "build", "references"]) {
      expect((await fs.stat(path.join(target, dir))).isDirectory()).toBe(true);
    }
    const brief = await fs.readFile(path.join(target, "project_brief.md"), "utf-8");
    expect(brief).toContain("Long-horizon agent memory");
    expect(brief).toContain("Ada Lovelace <ada@example.com>");
    const longwrite = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(longwrite.project.authors).toEqual([{ name: "Ada Lovelace", email: "ada@example.com" }]);
    expect(longwrite.research.topic).toBe("Long-horizon agent memory");
    expect(longwrite.research.provider).toBe("semantic_scholar");
    expect(longwrite.writing).toEqual({
      // The agentic research mode always applies its release-grade default
      // manuscript target.
      target_length_words: 24000,
      reference_links: [],
      reference_files: [],
      output_formats: ["markdown"],
    });
    expect(longwrite.review).toEqual({
      cadence: "daily",
      time: "08:00",
      interval_hours: 6,
      batch_approvals: true,
    });
    const manifest = parseYaml(await fs.readFile(path.join(target, "malaclaw.yaml"), "utf-8"));
    expect(manifest.workflow.mode).toBe("auto_research_agentic");
    const recall = manifest.workflow.stages.find((s: { id: string }) => s.id === "recall");
    expect(recall.command.args).toContain("semantic_scholar");
    expect(manifest.workflow.stages.some((s: { id: string }) => s.id === "draft_sections")).toBe(true);
    await fs.access(path.join(target, "templates", "agents", "research-lead.yaml"));
    await fs.access(path.join(target, "templates", "packs", "manuscript-writing.yaml"));
  });

  it("refuses to overwrite an existing malaclaw.yaml", async () => {
    process.env.LONGWRITE_TEMPLATES_DIR = path.resolve("templates");
    const root = await makeWorkspaceRoot();
    const target = path.join(root, "survey");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "malaclaw.yaml"), "version: 1\n", "utf-8");
    const mode = await loadMode("auto_research_agentic");
    await expect(scaffoldWorkspace({ mode, targetDir: target, projectId: "survey" }))
      .rejects.toThrow(/Refusing/);
  });
});

describe("language and style directives", () => {
  it("auto-detects CJK topics and writes directives into the brief", async () => {
    const { detectLanguage } = await import("../src/lib/scaffold.js");
    expect(detectLanguage("大语言模型智能体的工具使用")).toBe("zh");
    expect(detectLanguage("エージェントの記憶")).toBe("ja");
    expect(detectLanguage("에이전트 메모리")).toBe("ko");
    expect(detectLanguage("LLM agent memory")).toBeUndefined();
    expect(detectLanguage("LLM agent memory", "zh")).toBe("zh");
  });
});
