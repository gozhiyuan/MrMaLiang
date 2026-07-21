import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { syncWorkspace } from "../src/lib/sync.js";
import { computeWordMetrics, countWords, writeWordMetrics } from "../src/lib/ops/word-metrics.js";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-sync-"));
  roots.push(dir);
  await fs.writeFile(path.join(dir, "longwrite.yaml"), stringifyYaml({
    version: 1,
    project: { id: "book", name: "Book", artifact_type: "book", mode: "technical_book", authors: [{ name: "Ada Lovelace" }] },
    research: { provider: "seed", topic: "Reliable agent workflows" },
    writing: {
      target_length_words: 1000,
      genre: "technical guide",
      audience: "software engineers",
      style_instructions: "direct and practical",
      reference_links: ["https://example.com/ref"],
      reference_files: ["notes/style.pdf"],
      output_formats: ["markdown"],
    },
    review: { cadence: "manual", time: "08:00", interval_hours: 4, batch_approvals: false },
  }));
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("syncWorkspace", () => {
  it("regenerates project_brief.md and malaclaw.yaml from longwrite.yaml", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, "project_brief.md"), "stale", "utf-8");
    await fs.writeFile(path.join(ws, "malaclaw.yaml"), "stale: true\n", "utf-8");

    const result = await syncWorkspace(ws);
    expect(result.written).toEqual([".env.example", ".gitignore", "project_brief.md", "malaclaw.yaml"]);
    expect(await fs.readFile(path.join(ws, ".env.example"), "utf-8")).toContain("OPENALEX_API_KEY=");
    expect(await fs.readFile(path.join(ws, ".gitignore"), "utf-8")).toContain(".env");

    const brief = await fs.readFile(path.join(ws, "project_brief.md"), "utf-8");
    expect(brief).toContain("Reliable agent workflows");
    expect(brief).toContain("Target length: about 1000 words total.");
    expect(brief).toContain("Author: Ada Lovelace");
    expect(brief).toContain("Reference link: https://example.com/ref");
    expect(brief).toContain("Reference-use policy:");
    expect(brief).toContain("Reference-file access:");

    const manifest = await fs.readFile(path.join(ws, "malaclaw.yaml"), "utf-8");
    expect(manifest).toContain("mode: technical_book");
    expect(manifest).toContain("workflow:");
  });
});

describe("word metrics", () => {
  it("counts prose words while ignoring fenced code", () => {
    expect(countWords("One two.\n```js\nconst noisy = true;\n```\n中文")).toBe(4);
  });

  it("uses build/manuscript.md when present and writes reports", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "build"), { recursive: true });
    await fs.writeFile(path.join(ws, "build", "manuscript.md"), "# Title\n\none two three four five\n", "utf-8");

    const metrics = await computeWordMetrics(ws);
    expect(metrics.totalWords).toBe(6);
    expect(metrics.targetWords).toBe(1000);
    expect(metrics.status).toBe("short");
    expect(metrics.manuscriptPath).toBe("build/manuscript.md");

    await writeWordMetrics(ws);
    expect(await fs.readFile(path.join(ws, "reports", "word-metrics.md"), "utf-8")).toContain("Total words: 6");
  });

  it("falls back to summing chapter files", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.writeFile(path.join(ws, "chapters", "one.md"), "alpha beta", "utf-8");
    await fs.writeFile(path.join(ws, "chapters", "two.md"), "gamma delta epsilon", "utf-8");

    const metrics = await computeWordMetrics(ws);
    expect(metrics.totalWords).toBe(5);
    expect(metrics.entries.map((entry) => entry.path)).toEqual(["chapters/one.md", "chapters/two.md"]);
  });
});

describe("run_limits compile-through", () => {
  it("scaffold writes run_limits to longwrite.yaml and malaclaw.yaml, and sync preserves them", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { parse } = await import("yaml");
    const { loadMode } = await import("../src/lib/modes.js");
    const { scaffoldWorkspace } = await import("../src/lib/scaffold.js");
    const { syncWorkspace } = await import("../src/lib/sync.js");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-limits-"));
    try {
      const ws = path.join(root, "p");
      await scaffoldWorkspace({
        mode: await loadMode("auto_research_agentic"),
        targetDir: ws,
        projectId: "p",
        topic: "guardrails",
        runLimits: { max_recorded_tokens: 100_000, max_unit_minutes: 10, on_limit: "pause" },
      });
      const config = parse(await fs.readFile(path.join(ws, "longwrite.yaml"), "utf-8"));
      expect(config.run_limits.max_recorded_tokens).toBe(100_000);
      const manifest = parse(await fs.readFile(path.join(ws, "malaclaw.yaml"), "utf-8"));
      expect(manifest.workflow.run_limits).toEqual({
        max_recorded_tokens: 100_000, max_unit_minutes: 10, on_limit: "pause",
      });

      // Durable: sync regenerates malaclaw.yaml FROM longwrite.yaml.
      await syncWorkspace(ws);
      const regenerated = parse(await fs.readFile(path.join(ws, "malaclaw.yaml"), "utf-8"));
      expect(regenerated.workflow.run_limits.max_recorded_tokens).toBe(100_000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("research policy config", () => {
  it("syncs candidate/query targets into the generated recall command", async () => {
    const ws = await makeWorkspace();
    const raw = stringifyYaml({
      version: 1,
      project: { id: "paper", artifact_type: "research_paper", mode: "auto_research_agentic", authors: [] },
      research: {
        provider: "seed", topic: "evidence retrieval", target_candidates: 240, query_budget: 30,
        taxonomy: ["planning", "memory"],
        source_policy: { min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6 },
        fulltext: { max_core_sources: 32, allow_pdf_download: true }, retrieval: { backend: "sqlite_fts" },
      },
      writing: { reference_links: [], reference_files: [], output_formats: ["markdown"] },
      review: { cadence: "manual", time: "08:00", interval_hours: 4, batch_approvals: false },
      execution: { stage_overrides: {} },
    });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), raw, "utf-8");
    await syncWorkspace(ws);
    const manifest = (await import("yaml")).parse(await fs.readFile(path.join(ws, "malaclaw.yaml"), "utf-8"));
    const recall = manifest.workflow.stages.find((stage: { id: string }) => stage.id === "recall");
    expect(recall.command.args).toEqual(expect.arrayContaining(["--target-candidates", "240", "--query-budget", "30"]));
  });
});

describe("scaffolded roles", () => {
  it("compiles distinct persona files for each agent owner", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { loadMode } = await import("../src/lib/modes.js");
    const { scaffoldWorkspace } = await import("../src/lib/scaffold.js");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-roles-"));
    try {
      const ws = path.join(root, "p");
      await scaffoldWorkspace({
        mode: await loadMode("auto_research_agentic"),
        targetDir: ws,
        projectId: "p",
        topic: "roles",
      });
      const lead = await fs.readFile(path.join(ws, "roles", "research-lead.md"), "utf-8");
      const writer = await fs.readFile(path.join(ws, "roles", "chapter-writer.md"), "utf-8");
      const reviewer = await fs.readFile(path.join(ws, "roles", "skeptical-reviewer.md"), "utf-8");
      expect(lead).toContain("Never fabricate citations");
      expect(lead).not.toBe(writer);
      expect(writer).not.toBe(reviewer);
      // Boundaries survive compilation.
      expect(lead).toContain("Boundaries (non-negotiable):");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
