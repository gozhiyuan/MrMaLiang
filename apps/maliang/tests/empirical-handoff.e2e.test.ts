import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(monorepoRoot, "apps", "maliang", "dist", "cli.js");
const temporaryRoot = path.join(os.tmpdir(), `maliang-e2e-${Date.now()}`);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function invoke(args: string[]): void {
  execFileSync(process.execPath, [cli, ...args], { cwd: monorepoRoot, stdio: "pipe" });
}

afterAll(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

describe("empirical handoff", () => {
  it("imports only a complete audited manifest and creates bounded writing evidence", async () => {
    const repository = path.join(temporaryRoot, "audited-repository");
    await fs.mkdir(repository, { recursive: true });
    execFileSync("git", ["init"], { cwd: repository, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "MrMaLiang Test"], { cwd: repository, stdio: "pipe" });
    await fs.writeFile(path.join(repository, "README.md"), "# Audited repository\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repository, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository, stdio: "pipe" });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const workspace = path.join(temporaryRoot, "paper");
    invoke(["init", workspace, "--template", "paper.empirical-import", "--topic", "Audited handoff", "--repository", repository]);
    const writingConfig = await fs.readFile(path.join(workspace, "writing", "longwrite.yaml"), "utf8");
    expect(writingConfig).toContain("manifest_path: experiments/longexperiment-manifest.json");
    await expect(fs.stat(path.join(workspace, "experiment"))).rejects.toThrow();
    const experiment = path.join(temporaryRoot, "audited-source");
    const trials = [1, 2, 3].flatMap((seed) => [
      { id: `control-${seed}`, seed, condition: "control", status: "completed", metrics: { score: 0.5 }, artifacts: [] },
      { id: `candidate-${seed}`, seed, condition: "candidate", status: "completed", metrics: { score: 0.7 }, artifacts: [] },
    ]);
    const raw = JSON.stringify({ version: 1, status: "completed", trial_count: trials.length, trials }, null, 2);
    await fs.mkdir(path.join(experiment, "results"), { recursive: true });
    await fs.writeFile(path.join(experiment, "results", "raw-results.json"), `${raw}\n`, "utf8");
    const manifest = {
      version: 1, project_id: "experiment", hypothesis: "Audited evidence reduces unsupported claims", status: "completed", best_run_id: "candidate-vs-control",
      trial_count: trials.length, statistical_test: "paired bootstrap", metrics: { score: 0.7 }, trials,
      comparisons: [{ id: "candidate-vs-control", metric: "score", baseline_condition: "control", treatment_condition: "candidate", estimate: 0.2, confidence_interval: { level: 0.95, lower: 0.2, upper: 0.2 }, method: "paired bootstrap", paired_seeds: [1, 2, 3] }],
      artifacts: { results_json: "results/raw-results.json", tables: [], figures: [], logs: [] },
      provenance: { runner_kind: "command", input_revisions: { "repo-audited-repository": revision }, input_locks_sha256: "a".repeat(64), result_sha256: sha256(`${raw}\n`), environment: {}, generated_at: "2026-07-19T00:00:00.000Z" },
      publication_eligible: true,
    };
    await fs.writeFile(path.join(experiment, "results", "experiment-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    invoke(["handoff", "import", workspace, "--manifest", path.join(experiment, "results", "experiment-manifest.json")]);

    const packet = JSON.parse(await fs.readFile(path.join(workspace, "writing", "evidence", "experiment-packets.json"), "utf8"));
    const codebases = JSON.parse(await fs.readFile(path.join(workspace, "writing", "codebases", "manifest.json"), "utf8"));
    const lifecycle = JSON.parse(await fs.readFile(path.join(workspace, "runs", "lifecycle-state.json"), "utf8"));
    const provenance = JSON.parse(await fs.readFile(path.join(workspace, "reports", "run-provenance.json"), "utf8"));
    expect(packet.trial_count).toBe(6);
    expect(packet.comparisons[0].metric).toBe("score");
    expect(packet.codebase_binding.pass).toBe(true);
    expect(codebases.codebases[0].resolved_commit).toBe(revision);
    expect(lifecycle.phases.handoff.status).toBe("completed");
    expect(provenance.records.some((record: { event: string }) => record.event === "empirical_handoff_verified")).toBe(true);
  }, 30_000);
});
