import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runInit } from "../src/commands/init.js";
import { runPreflight } from "../src/commands/preflight.js";
import { packagePublicationWorkspace, validatePublicationWorkspace } from "../src/lib/publication.js";
import { buildLatexWorkspace } from "../src/lib/writing/latex.js";

const tempDirs: string[] = [];

async function workspace(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-publication-"));
  tempDirs.push(root);
  const target = path.join(root, name);
  await runInit(target, { mode: "auto_research_agentic", topic: "Evidence-backed agent memory", outputFormat: ["markdown"] });
  return target;
}

afterEach(async () => {
  delete process.env.LONGWRITE_LATEX_ENGINE;
  delete process.env.LONGWRITE_PYTHON_BIN;
  process.exitCode = undefined;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("publication packaging", () => {
  it("copies a custom class, renders anonymous front matter, and creates a portable source bundle", async () => {
    const ws = await workspace("custom");
    const configPath = path.join(ws, "longwrite.yaml");
    const config = parseYaml(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    config.publication = {
      target: "custom",
      anonymous: true,
      required_sections: ["Introduction"],
      template_dir: "templates/venue",
      document_class: "venue",
      document_class_options: ["review"],
    };
    await fs.mkdir(path.join(ws, "templates", "venue"), { recursive: true });
    await fs.writeFile(path.join(ws, "templates", "venue", "venue.cls"), "\\NeedsTeXFormat{LaTeX2e}\n\\LoadClass{article}\n", "utf-8");
    await fs.writeFile(configPath, stringifyYaml(config), "utf-8");
    await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({ sections: [{ id: "introduction", title: "Introduction" }] }), "utf-8");
    await fs.writeFile(path.join(ws, "chapters", "introduction.md"), "# Introduction\n\nA manuscript body.\n", "utf-8");
    await fs.mkdir(path.join(ws, "paper"), { recursive: true });
    await fs.writeFile(path.join(ws, "paper", "abstract.md"), "An anonymous abstract.", "utf-8");
    process.env.LONGWRITE_LATEX_ENGINE = "none";
    await buildLatexWorkspace(ws);

    const report = await validatePublicationWorkspace(ws);
    expect(report.pass).toBe(true);
    const written = await packagePublicationWorkspace(ws);
    expect(written).toContain("build/submission/custom");
    const main = await fs.readFile(path.join(ws, "build", "submission", "custom", "main.tex"), "utf-8");
    expect(main).toContain("\\documentclass[review]{venue}");
    expect(main).toContain("\\author{Anonymous}");
    await expect(fs.stat(path.join(ws, "build", "submission", "custom", "venue.cls"))).resolves.toBeTruthy();
  });

  it("writes an inspectable no-LLM preflight report before a run", async () => {
    const ws = await workspace("preflight");
    process.env.LONGWRITE_PYTHON_BIN = process.execPath;
    await runPreflight(ws);
    const report = JSON.parse(await fs.readFile(path.join(ws, "reports", "preflight.json"), "utf-8"));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "direct_llm_drafting", pass: true }),
      expect.objectContaining({ id: "review_topology", pass: true }),
      expect.objectContaining({ id: "draft_concurrency", pass: true }),
      expect.objectContaining({ id: "token_guardrail", pass: true }),
      expect.objectContaining({ id: "public_release_urls", pass: true }),
      expect.objectContaining({ id: "publication_figure_renderer", pass: false }),
    ]));
  });
});
