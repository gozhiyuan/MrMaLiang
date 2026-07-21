import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Real LaTeX compilation with graceful fallback.
 *
 *  Engines, in preference order: tectonic (self-contained, fetches packages),
 *  latexmk (TeX Live). `LONGWRITE_LATEX_ENGINE` forces one ("tectonic",
 *  "latexmk", or "none" to skip real compilation); `LONGWRITE_LATEX_BIN`
 *  overrides the binary path only when the engine is forced, so an override is
 *  never guessed as the wrong engine. When no engine is available the
 *  deterministic placeholder PDF stands, and reports/latex-build.md says so —
 *  the build stage stays green either way, per the fallback contract. */

export type LatexEngine = "tectonic" | "latexmk";

export type LatexCompileResult = {
  engine: LatexEngine | "placeholder";
  compiled: boolean;
  warnings: string[];
  errors: string[];
  logTail: string;
};

const COMPILE_TIMEOUT_MS = 180_000;

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // openout_any=a: TeX Live's paranoid default blocks bibtex from writing
    // into ../build (any parent-relative path). Scoped to this child only.
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, openout_any: "a" },
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString("utf-8") });
    });
  });
}

async function binWorks(bin: string, args: string[]): Promise<boolean> {
  const probe = await run(bin, args, process.cwd(), 10_000);
  return probe.code === 0;
}

export async function detectLatexEngine(): Promise<{ engine: LatexEngine; bin: string } | null> {
  const forced = process.env.LONGWRITE_LATEX_ENGINE?.trim();
  if (forced === "none") return null;
  const binOverride = process.env.LONGWRITE_LATEX_BIN?.trim();

  const candidates: Array<{ engine: LatexEngine; bin: string; probeArgs: string[] }> = [];
  if (forced === "tectonic" || forced === "latexmk") {
    candidates.push({
      engine: forced,
      bin: binOverride || forced,
      probeArgs: forced === "tectonic" ? ["--version"] : ["-version"],
    });
  } else if (binOverride) {
    return null;
  } else {
    candidates.push(
      { engine: "tectonic", bin: "tectonic", probeArgs: ["--version"] },
      { engine: "latexmk", bin: "latexmk", probeArgs: ["-version"] },
    );
  }

  for (const candidate of candidates) {
    if (await binWorks(candidate.bin, candidate.probeArgs)) {
      return { engine: candidate.engine, bin: candidate.bin };
    }
  }
  return null;
}

/** LaTeX log lines worth surfacing: undefined citations/references, layout
 * overflow, and outright errors. */
export function extractLatexFindings(log: string): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const line of log.split("\n")) {
    if (/Citation .* undefined|I didn't find a database entry|Reference .* undefined|There were undefined (citations|references)|Overfull \\hbox/.test(line)) {
      warnings.push(line.trim());
    }
    if (/^!\s|Fatal error|Emergency stop/.test(line)) {
      errors.push(line.trim());
    }
  }
  return { warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
}

/** Compile paper/main.tex into build/manuscript.pdf with the detected engine.
 *  Never throws: failures are reported, and the caller's placeholder PDF
 *  remains the deliverable. */
export async function compileLatex(workspaceDir: string): Promise<LatexCompileResult> {
  const detected = await detectLatexEngine();
  if (!detected) {
    return {
      engine: "placeholder",
      compiled: false,
      warnings: [],
      errors: [],
      logTail: "No LaTeX engine found (tectonic/latexmk). Placeholder PDF kept. Set LONGWRITE_LATEX_ENGINE/LONGWRITE_LATEX_BIN to enable real builds.",
    };
  }

  const paperDir = path.join(workspaceDir, "paper");
  const buildDir = path.join(workspaceDir, "build");
  await fs.mkdir(buildDir, { recursive: true });

  const args = detected.engine === "tectonic"
    ? ["main.tex", "-o", buildDir]
    : ["-pdf", "-interaction=nonstopmode", `-output-directory=${buildDir}`, "main.tex"];
  const result = await run(detected.bin, args, paperDir, COMPILE_TIMEOUT_MS);
  const { warnings, errors } = extractLatexFindings(result.output);
  const logTail = result.output.slice(-4_000);

  if (result.code !== 0) {
    return { engine: detected.engine, compiled: false, warnings, errors, logTail };
  }

  // Both engines emit build/main.pdf for paper/main.tex. Normalize this to
  // the one public artifact; retaining both was confusing and let users pick
  // an implementation intermediate by accident.
  try {
    await fs.copyFile(path.join(buildDir, "main.pdf"), path.join(buildDir, "manuscript.pdf"));
    await fs.rm(path.join(buildDir, "main.pdf"), { force: true });
  } catch {
    return {
      engine: detected.engine,
      compiled: false,
      warnings,
      errors: [...errors, "engine exited 0 but build/main.pdf was not produced"],
      logTail,
    };
  }
  return { engine: detected.engine, compiled: true, warnings, errors, logTail };
}

export async function writeLatexBuildReport(workspaceDir: string, result: LatexCompileResult): Promise<string> {
  const rel = path.join("reports", "latex-build.md");
  const lines = [
    "# LaTeX Build Report",
    "",
    `- Engine: ${result.engine}`,
    `- Real PDF compiled: ${result.compiled ? "yes" : "no (placeholder PDF in build/manuscript.pdf)"}`,
    "",
  ];
  if (result.errors.length > 0) {
    lines.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  }
  if (result.warnings.length > 0) {
    lines.push("## Warnings (citations/references)", "", ...result.warnings.map((w) => `- ${w}`), "");
  }
  lines.push("## Log tail", "", "```", result.logTail.trim(), "```", "");
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, rel), lines.join("\n"), "utf-8");
  return rel;
}
