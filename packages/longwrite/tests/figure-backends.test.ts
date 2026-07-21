import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  renderFigureBackends,
  researchPipelineMermaid,
  sourceYearsPlotScript,
} from "../src/lib/writing/figure-backends.js";
import { buildFigureWorkspace, readFigureManifest } from "../src/lib/writing/figures.js";

const tempDirs: string[] = [];
async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-figback-"));
  tempDirs.push(dir);
  return dir;
}

const envKeys = ["LONGWRITE_MMDC_BIN", "LONGWRITE_PYTHON_BIN"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of envKeys) savedEnv[key] = process.env[key];

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function writeStub(dir: string, name: string, script: string): Promise<string> {
  const stubPath = path.join(dir, name);
  await fs.writeFile(stubPath, script, { mode: 0o755 });
  return stubPath;
}

const classifiedSources = [
  { id: "s1", title: "Paper One", authors: ["A"], year: 2025, venue: "V", url: "https://x", abstract: "a", source: "arxiv", topics: [], quality_score: 0.9, score_rationale: "r", citation_depth: "core" },
  { id: "s2", title: "Paper Two", authors: ["B"], year: 2026, venue: "V", url: "https://y", abstract: "b", source: "arxiv", topics: [], quality_score: 0.8, score_rationale: "r", citation_depth: "supporting" },
];

async function seedClassified(ws: string): Promise<void> {
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(
    path.join(ws, "sources", "classified_sources.jsonl"),
    classifiedSources.map((s) => JSON.stringify(s)).join("\n") + "\n",
    "utf-8",
  );
}

describe("deterministic backend sources", () => {
  it("emits a pipeline mermaid diagram and a matplotlib script", () => {
    expect(researchPipelineMermaid()).toContain("flowchart LR");
    expect(researchPipelineMermaid()).toContain("Quality loop");
    expect(sourceYearsPlotScript()).toContain("matplotlib");
    expect(sourceYearsPlotScript()).toContain("source-years.csv");
  });
});

describe("renderFigureBackends", () => {
  it("writes sources and reports unavailable backends without failing", async () => {
    const ws = await makeWorkspace();
    process.env.LONGWRITE_MMDC_BIN = "/nonexistent/mmdc";
    process.env.LONGWRITE_PYTHON_BIN = "/nonexistent/python3";
    const result = await renderFigureBackends(ws);
    expect(result.written).toEqual(expect.arrayContaining([
      "figures/workflow.mmd",
      "scripts/plot_source_years.py",
      "reports/figures-build.md",
    ]));
    expect(result.statuses.every((s) => !s.available)).toBe(true);
    const report = await fs.readFile(path.join(ws, "reports", "figures-build.md"), "utf-8");
    expect(report).toContain("Available: no");
  });

  it("renders through stubbed mermaid and python backends", async () => {
    const ws = await makeWorkspace();
    // Stub mmdc: probe on --version; render writes the -o target.
    process.env.LONGWRITE_MMDC_BIN = await writeStub(ws, "mmdc-stub", `#!/bin/sh
if [ "$1" = "--version" ]; then echo "10.0-stub"; exit 0; fi
# -i in -o out --quiet
printf '<svg>stub</svg>' > "$4"
`);
    // Stub python: probe with -c succeeds; running the script writes the png.
    process.env.LONGWRITE_PYTHON_BIN = await writeStub(ws, "python-stub", `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
mkdir -p figures
printf 'PNG-stub' > figures/source-years-plot.png
`);
    const result = await renderFigureBackends(ws);
    expect(result.statuses.find((s) => s.backend === "mermaid")?.rendered).toEqual(["figures/workflow.svg"]);
    expect(result.statuses.find((s) => s.backend === "python")?.rendered).toEqual(["figures/source-years-plot.png"]);
    expect(await fs.readFile(path.join(ws, "figures", "workflow.svg"), "utf-8")).toContain("stub");
  });
});

describe("manifest integration", () => {
  it("only lists backend figures that actually rendered", async () => {
    const ws = await makeWorkspace();
    await seedClassified(ws);
    process.env.LONGWRITE_MMDC_BIN = "/nonexistent/mmdc";
    process.env.LONGWRITE_PYTHON_BIN = "/nonexistent/python3";
    await buildFigureWorkspace(ws);
    const manifest = await readFigureManifest(ws);
    expect(manifest?.figures.map((f) => f.id)).toEqual(["source-years", "concept-map"]);
  });

  it("keeps rendered backend figures out of the publication manifest until they have a LaTeX placement contract", async () => {
    const ws = await makeWorkspace();
    await seedClassified(ws);
    process.env.LONGWRITE_MMDC_BIN = await writeStub(ws, "mmdc-stub", `#!/bin/sh
if [ "$1" = "--version" ]; then echo "10.0-stub"; exit 0; fi
printf '<svg>stub</svg>' > "$4"
`);
    process.env.LONGWRITE_PYTHON_BIN = "/nonexistent/python3";
    await buildFigureWorkspace(ws);
    const manifest = await readFigureManifest(ws);
    expect(manifest?.figures.map((f) => f.id)).toEqual(["source-years", "concept-map"]);
    expect(await fs.readFile(path.join(ws, "figures", "workflow.svg"), "utf-8")).toContain("stub");
  });

  it("writes source-year data before invoking the Python backend", async () => {
    const ws = await makeWorkspace();
    await seedClassified(ws);
    process.env.LONGWRITE_MMDC_BIN = "/nonexistent/mmdc";
    process.env.LONGWRITE_PYTHON_BIN = await writeStub(ws, "python-stub", `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
if [ ! -f data/source-years.csv ]; then echo "missing csv" >&2; exit 7; fi
mkdir -p figures
printf 'PNG-stub' > figures/source-years-plot.png
`);
    await buildFigureWorkspace(ws);
    const manifest = await readFigureManifest(ws);
    expect(manifest?.figures.map((f) => f.id)).toEqual(["source-years", "concept-map"]);
    expect(await fs.readFile(path.join(ws, "figures", "source-years-plot.png"), "utf-8")).toBe("PNG-stub");
  });
});

describe("nanobanana backend", () => {
  const nbEnv = ["LONGWRITE_NANOBANANA_BASE_URL", "LONGWRITE_NANOBANANA_API_KEY", "LONGWRITE_NANOBANANA_APPROVED", "GEMINI_API_KEY", "MALACLAW_GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
  const nbSaved: Record<string, string | undefined> = {};
  for (const key of nbEnv) nbSaved[key] = process.env[key];

  async function nbWorkspace(config: string): Promise<string> {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, "longwrite.yaml"), config, "utf-8");
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "figure-plan.md"), "# Figure Plan\nconcept coverage", "utf-8");
    await fs.writeFile(path.join(ws, "project_brief.md"), "# Brief\nA survey of agents.", "utf-8");
    return ws;
  }

  const baseConfig = (nanobanana: string) => [
    "version: 1",
    "project:",
    "  id: t",
    "  artifact_type: research_paper",
    "  mode: auto_research_agentic",
    "figures:",
    "  backends:",
    "    nanobanana:",
    nanobanana,
    "",
  ].join("\n");

  afterEach(() => {
    for (const key of nbEnv) {
      if (nbSaved[key] === undefined) delete process.env[key];
      else process.env[key] = nbSaved[key];
    }
  });

  it("is disabled by default and reports clear skip reasons", async () => {
    const { runNanobanana } = await import("../src/lib/writing/nanobanana.js");
    for (const key of nbEnv) delete process.env[key];

    const off = await runNanobanana(await nbWorkspace(baseConfig("      enabled: false")));
    expect(off.enabled).toBe(false);
    expect(off.ran).toBe(false);

    // Enabled but awaiting approval.
    const gated = await runNanobanana(await nbWorkspace(baseConfig("      enabled: true")));
    expect(gated.ran).toBe(false);
    expect(gated.detail).toContain("awaiting approval");

    // Approved but no key: clear message, no crash.
    process.env.LONGWRITE_NANOBANANA_APPROVED = "1";
    const keyless = await runNanobanana(await nbWorkspace(baseConfig("      enabled: true")));
    expect(keyless.ran).toBe(false);
    expect(keyless.detail).toContain("no API key");

    // Budget below one image: skip.
    const broke = await runNanobanana(await nbWorkspace(baseConfig("      enabled: true\n      budget_usd: 0.01")));
    expect(broke.ran).toBe(false);
    expect(broke.detail).toContain("budget");
  });

  it("renders an image with provenance through a stubbed API", async () => {
    const { runNanobanana } = await import("../src/lib/writing/nanobanana.js");
    const http = await import("node:http");
    const png = Buffer.from("PNG-nanobanana-stub").toString("base64");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      process.env.LONGWRITE_NANOBANANA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.LONGWRITE_NANOBANANA_API_KEY = "nb-key";
      process.env.LONGWRITE_NANOBANANA_APPROVED = "1";
      const ws = await nbWorkspace(baseConfig("      enabled: true"));
      const status = await runNanobanana(ws);
      expect(status.ran).toBe(true);
      expect(status.rendered).toEqual(["figures/concept.png", "figures/concept-provenance.json"]);
      expect((await fs.readFile(path.join(ws, "figures", "concept.png"))).toString()).toBe("PNG-nanobanana-stub");
      const provenance = JSON.parse(await fs.readFile(path.join(ws, "figures", "concept-provenance.json"), "utf-8"));
      expect(provenance.backend).toBe("nanobanana");
      expect(provenance.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(status.image).toMatchObject({ path: "figures/concept.png", mimeType: "image/png" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("places a generated image into the publication manifest with a LaTeX contract", async () => {
    const http = await import("node:http");
    const png = Buffer.from("PNG-nanobanana-stub").toString("base64");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      process.env.LONGWRITE_NANOBANANA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.LONGWRITE_NANOBANANA_API_KEY = "nb-key";
      process.env.LONGWRITE_NANOBANANA_APPROVED = "1";
      process.env.LONGWRITE_MMDC_BIN = "/nonexistent/mmdc";
      process.env.LONGWRITE_PYTHON_BIN = "/nonexistent/python3";
      const ws = await nbWorkspace(baseConfig("      enabled: true"));
      await seedClassified(ws);
      await buildFigureWorkspace(ws);
      const manifest = await readFigureManifest(ws);
      const illustration = manifest?.figures.find((figure) => figure.id === "concept-illustration");
      expect(illustration).toMatchObject({ backend: "nanobanana", path: "figures/concept.png", latex_path: "paper/figures/concept-illustration.tex" });
      await expect(fs.readFile(path.join(ws, "paper", "figures", "concept-illustration.tex"), "utf-8")).resolves.toContain("assets/concept.png");
      await expect(fs.readFile(path.join(ws, "figures", "figure-plan.md"), "utf-8")).resolves.toContain("concept-illustration");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
