import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadProjectConfig } from "../lib/project-config.js";
import { loadWorkspaceEnv } from "../lib/workspace-env.js";
import { requireSupportedNode } from "../lib/node-runtime.js";
import { runMalaClaw } from "../lib/malaclaw.js";
import { detectLatexEngine } from "../lib/writing/latex-compile.js";

type Check = { id: string; pass: boolean; finding: string };

function executable(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(bin, args, { timeout: 20_000 }, (error) => resolve(!error)));
}

function stages(value: unknown): Array<Record<string, unknown>> {
  const workflow = value && typeof value === "object" ? (value as { workflow?: unknown }).workflow : undefined;
  const raw = workflow && typeof workflow === "object" ? (workflow as { stages?: unknown }).stages : undefined;
  return Array.isArray(raw) ? raw.filter((stage): stage is Record<string, unknown> => Boolean(stage) && typeof stage === "object") : [];
}

function findStage(items: Array<Record<string, unknown>>, id: string): Record<string, unknown> | undefined {
  return items.find((stage) => stage.id === id);
}

export async function runPreflight(workspaceDir: string, opts: { runtime?: string } = {}): Promise<void> {
  requireSupportedNode("Running LongWrite preflight");
  const root = path.resolve(workspaceDir);
  await loadWorkspaceEnv(root);
  const config = await loadProjectConfig(root);
  const raw = await fs.readFile(path.join(root, "malaclaw.yaml"), "utf-8");
  const manifest = parseYaml(raw);
  const workflowStages = stages(manifest);
  const checks: Check[] = [];
  const draftGroup = findStage(workflowStages, "draft_sections");
  const draft = Array.isArray(draftGroup?.steps) ? draftGroup.steps.find((step) => step && typeof step === "object" && (step as { id?: unknown }).id === "draft") as Record<string, unknown> | undefined : undefined;
  const loop = findStage(workflowStages, "quality_loop");
  const loopStages = Array.isArray(loop?.stages) ? loop.stages as Array<Record<string, unknown>> : [];
  checks.push({ id: "direct_llm_drafting", pass: config.research.writing_strategy !== "llm_sections" || draft?.runtime !== "script", finding: config.research.writing_strategy === "llm_sections" && draft?.runtime === "script" ? "llm_sections is configured but draft_sections.draft is still script-owned" : "drafting strategy matches the generated manifest" });
  checks.push({ id: "review_topology", pass: Boolean(findStage(workflowStages, "baseline_review")) && loopStages.at(-1)?.id === "review", finding: Boolean(findStage(workflowStages, "baseline_review")) && loopStages.at(-1)?.id === "review" ? "baseline review and post-rebuild review are present" : "manifest must have baseline_review and end quality_loop with review" });
  checks.push({ id: "article_front_matter", pass: Boolean(findStage(workflowStages, "abstract")), finding: findStage(workflowStages, "abstract") ? "LLM abstract stage is present" : "abstract stage is missing" });
  checks.push({ id: "draft_concurrency", pass: typeof draftGroup?.max_parallel === "number" && draftGroup.max_parallel <= 2, finding: typeof draftGroup?.max_parallel === "number" && draftGroup.max_parallel <= 2 ? `draft max_parallel=${draftGroup.max_parallel}, compatible with Codex/Claude Code local caps` : "draft_sections.max_parallel must be at most 2 for the supported harness runtimes" });
  checks.push({ id: "token_guardrail", pass: typeof config.run_limits?.max_recorded_tokens === "number", finding: typeof config.run_limits?.max_recorded_tokens === "number" ? `recorded-token guardrail: ${config.run_limits.max_recorded_tokens}` : "set run_limits.max_recorded_tokens before a costly run" });
  if (config.project.mode === "auto_research_agentic") {
    checks.push({ id: "public_release_urls", pass: config.research.source_policy.require_live_urls, finding: config.research.source_policy.require_live_urls ? "live citation URLs are a final release gate" : "set research.source_policy.require_live_urls: true for a public release" });
  }
  const python = process.env.LONGWRITE_PYTHON_BIN ?? "python3";
  const matplotlib = await executable(python, ["-c", "import matplotlib"]);
  checks.push({ id: "publication_figure_renderer", pass: matplotlib, finding: matplotlib ? `${python} can render the required matplotlib publication figure` : `cannot import matplotlib with ${python}; configure LONGWRITE_PYTHON_BIN` });
  if (config.writing.output_formats.includes("pdf")) {
    const latex = await detectLatexEngine();
    checks.push({ id: "pdf_compiler", pass: latex !== null, finding: latex ? `${latex.engine} compiler available` : "install tectonic or TeX Live/latexmk before a PDF release run" });
  }
  if (opts.runtime) {
    try {
      await runMalaClaw(root, ["flow", "runtimes", "--runtime", opts.runtime]);
      checks.push({ id: "worker_runtime", pass: true, finding: `${opts.runtime} is available to MalaClaw` });
    } catch (error) {
      checks.push({ id: "worker_runtime", pass: false, finding: error instanceof Error ? error.message.split("\n")[0] : String(error) });
    }
  }
  const report = { version: 1, workspace: root, pass: checks.every((check) => check.pass), checks };
  await fs.mkdir(path.join(root, "reports"), { recursive: true });
  await fs.writeFile(path.join(root, "reports", "preflight.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(root, "reports", "preflight.md"), `# LongWrite Preflight\n\nStatus: ${report.pass ? "pass" : "fail"}\n\n${checks.map((check) => `- ${check.pass ? "✓" : "✗"} **${check.id}** — ${check.finding}`).join("\n")}\n`, "utf-8");
  console.log(`LongWrite preflight ${report.pass ? "passed" : "failed"}: ${root}`);
  for (const check of checks) console.log(`  ${check.pass ? "✓" : "✗"} ${check.id} — ${check.finding}`);
  if (!report.pass) process.exitCode = 1;
}
