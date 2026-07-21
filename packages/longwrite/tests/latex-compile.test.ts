import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileLatex, detectLatexEngine, extractLatexFindings } from "../src/lib/writing/latex-compile.js";
import { buildLatexWorkspace } from "../src/lib/writing/latex.js";
import { prepareResearchWorkspace } from "../src/lib/research/pipeline.js";
import { buildFigureWorkspace } from "../src/lib/writing/figures.js";
import { onePixelPng } from "./helpers/png.js";

const tempDirs: string[] = [];
async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-latexc-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "chapters"), { recursive: true });
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "chapters", "section-1.md"),
    "# Background\n\nAgents need grounded memory.\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "sources", "bibliography.bib"),
    "@misc{source1,\n  title = {Grounded Memory},\n  author = {A. Author},\n  year = {2026}\n}\n",
    "utf-8",
  );
  return dir;
}

const envKeys = ["LONGWRITE_LATEX_ENGINE", "LONGWRITE_LATEX_BIN"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of envKeys) savedEnv[key] = process.env[key];

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function latexmkAvailable(): boolean {
  try {
    execFileSync("latexmk", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("extractLatexFindings", () => {
  it("captures undefined citations/references and hard errors", () => {
    const log = [
      "LaTeX Warning: Citation `smith2024' on page 1 undefined on input line 10.",
      "Warning--I didn't find a database entry for \"ghost\"",
      "LaTeX Warning: Reference `fig:one' on page 2 undefined on input line 20.",
      "! Undefined control sequence.",
      "ordinary progress line",
    ].join("\n");
    const { warnings, errors } = extractLatexFindings(log);
    expect(warnings).toHaveLength(3);
    expect(errors).toHaveLength(1);
  });
});

describe("compileLatex", () => {
  it("returns placeholder mode when the engine is disabled", async () => {
    process.env.LONGWRITE_LATEX_ENGINE = "none";
    const ws = await makeWorkspace();
    const result = await compileLatex(ws);
    expect(result.engine).toBe("placeholder");
    expect(result.compiled).toBe(false);
    expect(await detectLatexEngine()).toBeNull();
  });

  it("uses a stubbed tectonic binary end to end", async () => {
    const ws = await makeWorkspace();
    const stub = path.join(ws, "fake-tectonic");
    await fs.writeFile(
      stub,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "tectonic 0.0-stub"; exit 0; fi
# compile call: main.tex -o <outdir>
printf '%%PDF-1.4 stub-real' > "$3/main.pdf"
echo "stub compiled ok"
`,
      { mode: 0o755 },
    );
    process.env.LONGWRITE_LATEX_ENGINE = "tectonic";
    process.env.LONGWRITE_LATEX_BIN = stub;

    await fs.mkdir(path.join(ws, "paper"), { recursive: true });
    await fs.writeFile(path.join(ws, "paper", "main.tex"), "\\documentclass{article}", "utf-8");
    const result = await compileLatex(ws);
    expect(result.engine).toBe("tectonic");
    expect(result.compiled).toBe(true);
    const pdf = await fs.readFile(path.join(ws, "build", "manuscript.pdf"), "utf-8");
    expect(pdf).toContain("stub-real");
  });

  it("reports failure without throwing when the engine exits non-zero", async () => {
    const ws = await makeWorkspace();
    const stub = path.join(ws, "fake-latexmk");
    await fs.writeFile(
      stub,
      `#!/bin/sh
if [ "$1" = "-version" ]; then echo "latexmk stub"; exit 0; fi
echo "! Undefined control sequence."
exit 12
`,
      { mode: 0o755 },
    );
    process.env.LONGWRITE_LATEX_ENGINE = "latexmk";
    process.env.LONGWRITE_LATEX_BIN = stub;
    await fs.mkdir(path.join(ws, "paper"), { recursive: true });
    const result = await compileLatex(ws);
    expect(result.compiled).toBe(false);
    expect(result.errors[0]).toContain("Undefined control sequence");
  });

  it("does not guess an engine when only LONGWRITE_LATEX_BIN is set", async () => {
    const ws = await makeWorkspace();
    const stub = path.join(ws, "fake-latexmk");
    await fs.writeFile(
      stub,
      `#!/bin/sh
if [ "$1" = "-version" ]; then echo "latexmk stub"; exit 0; fi
if [ "$1" = "--version" ]; then echo "not tectonic" >&2; exit 9; fi
exit 0
`,
      { mode: 0o755 },
    );
    delete process.env.LONGWRITE_LATEX_ENGINE;
    process.env.LONGWRITE_LATEX_BIN = stub;
    await expect(detectLatexEngine()).resolves.toBeNull();
  });
});

// Runs only where a real TeX distribution exists (dev laptops); skipped in CI.
describe.skipIf(!latexmkAvailable())("real latexmk compilation", () => {
  it("produces a real PDF through buildLatexWorkspace", async () => {
    process.env.LONGWRITE_LATEX_ENGINE = "latexmk";
    delete process.env.LONGWRITE_LATEX_BIN;
    const ws = await makeWorkspace();
    const written = await buildLatexWorkspace(ws);
    expect(written).toContain("reports/latex-build.md");

    const report = await fs.readFile(path.join(ws, "reports", "latex-build.md"), "utf-8");
    expect(report).toContain("Engine: latexmk");
    expect(report).toContain("Real PDF compiled: yes");

    const pdf = await fs.readFile(path.join(ws, "build", "manuscript.pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // A real compiled PDF is far larger than the ~600-byte placeholder.
    expect(pdf.length).toBeGreaterThan(5_000);
  }, 120_000);

  it("compiles a manuscript with a placed publication figure and table", async () => {
    process.env.LONGWRITE_LATEX_ENGINE = "latexmk";
    delete process.env.LONGWRITE_LATEX_BIN;
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-latex-figures-"));
    tempDirs.push(ws);
    await prepareResearchWorkspace({
      workspaceDir: ws,
      topic: "Long-horizon agent memory",
      count: 5,
      provider: "seed",
    });
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Background\n\nDurable plans need evidence-backed memory [source:source-1].\n",
      "utf-8",
    );
    await buildFigureWorkspace(ws);
    await fs.writeFile(path.join(ws, "figures", "source-years-plot.png"), onePixelPng());
    await buildLatexWorkspace(ws);
    const report = await fs.readFile(path.join(ws, "reports", "latex-build.md"), "utf-8");
    expect(report).toContain("Real PDF compiled: yes");
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\input{figures/source-years.tex}");
    expect(section).toContain("\\input{tables/evidence-profile.tex}");
  }, 120_000);
});
