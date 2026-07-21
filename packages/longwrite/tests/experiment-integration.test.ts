import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importExperimentManifest, prepareImportedExperiment } from "../src/commands/research.js";
import { validateImportedExperiment } from "../src/lib/research/experiment.js";
import { prepareResearchWorkspace } from "../src/lib/research/pipeline.js";
import { buildFigureWorkspace } from "../src/lib/writing/figures.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function fixture(): Promise<{ paper: string; manifest: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-experiment-")); dirs.push(root);
  const paper = path.join(root, "paper"); const experiment = path.join(root, "experiment");
  await fs.mkdir(path.join(experiment, "results"), { recursive: true }); await fs.mkdir(path.join(experiment, "artifacts"), { recursive: true });
  const raw = Buffer.from(JSON.stringify({ raw: "verified" })); await fs.writeFile(path.join(experiment, "results", "raw-results.json"), raw);
  await fs.writeFile(path.join(experiment, "artifacts", "result.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>\n");
  const trials = [
    { id: "baseline-11", seed: 11, condition: "baseline", status: "completed", metrics: { score: 0.5 }, artifacts: [] },
    { id: "candidate-11", seed: 11, condition: "candidate", status: "completed", metrics: { score: 0.7 }, artifacts: [] },
    { id: "baseline-23", seed: 23, condition: "baseline", status: "completed", metrics: { score: 0.6 }, artifacts: [] },
    { id: "candidate-23", seed: 23, condition: "candidate", status: "completed", metrics: { score: 0.8 }, artifacts: [] },
  ];
  const manifest = { version: 1, project_id: "fixture", hypothesis: "Candidate improves score.", status: "completed", best_run_id: "candidate-v-baseline", trial_count: 4, statistical_test: "paired bootstrap confidence interval", metrics: { candidate: 0.75 }, trials,
    comparisons: [{ id: "candidate-v-baseline", metric: "score", baseline_condition: "baseline", treatment_condition: "candidate", estimate: 0.2, confidence_interval: { level: 0.95, lower: 0.2, upper: 0.2 }, method: "deterministic paired bootstrap", paired_seeds: [11, 23] }],
    artifacts: { results_json: "results/raw-results.json", tables: [], figures: ["artifacts/result.svg"], logs: [] },
    provenance: { runner_kind: "command", runner_version: "fixture", input_revisions: { repo: "abcdef1234567" }, input_locks_sha256: "a".repeat(64), result_sha256: hash(raw), environment: {}, generated_at: "2026-07-19T00:00:00.000Z" }, publication_eligible: true };
  await fs.writeFile(path.join(experiment, "results", "experiment-manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.mkdir(paper, { recursive: true });
  await fs.writeFile(path.join(paper, "longwrite.yaml"), JSON.stringify({ version: 1, project: { id: "empirical-paper", artifact_type: "research_paper", mode: "auto_research_agentic" }, research: { paper_kind: "empirical", experiment: { enabled: true, manifest_path: "experiments/longexperiment-manifest.json", min_trials: 3 } } }, null, 2));
  return { paper, manifest: path.join(experiment, "results", "experiment-manifest.json") };
}

describe("LongExperiment evidence integration", () => {
  it("imports checksummed experiment artifacts and exposes only bounded result packets", async () => {
    const { paper, manifest } = await fixture();
    await expect(importExperimentManifest(paper, manifest)).resolves.toBe("experiments/longexperiment-manifest.json");
    await expect(prepareImportedExperiment(paper)).resolves.toEqual(expect.arrayContaining(["evidence/experiment-packets.json", "experiments/verification.json"]));
    const packet = JSON.parse(await fs.readFile(path.join(paper, "evidence", "experiment-packets.json"), "utf8"));
    expect(packet.comparisons[0]).toMatchObject({ metric: "score", paired_seeds: [11, 23] });
    expect(packet.artifacts[0].imported_path).toMatch(/^experiments\/imported\//);
    expect((await validateImportedExperiment(paper)).pass).toBe(true);
    await prepareResearchWorkspace({ workspaceDir: paper, topic: "experiment evidence", count: 5, provider: "seed" });
    await buildFigureWorkspace(paper);
    const figures = JSON.parse(await fs.readFile(path.join(paper, "figures", "manifest.json"), "utf8"));
    expect(figures.figures).toEqual(expect.arrayContaining([expect.objectContaining({ backend: "experiment-import" })]));
    expect(figures.tables).toEqual(expect.arrayContaining([expect.objectContaining({ id: "empirical-comparisons", backend: "experiment-summary" })]));
  }, 30_000);

  it("rejects a copied artifact that no longer matches its import checksum", async () => {
    const { paper, manifest } = await fixture();
    await importExperimentManifest(paper, manifest);
    const bundle = JSON.parse(await fs.readFile(path.join(paper, "experiments", "artifact-bundle.json"), "utf8"));
    await fs.writeFile(path.join(paper, bundle.artifacts[0].imported_path), "tampered");
    const result = await validateImportedExperiment(paper);
    expect(result.pass).toBe(false);
    expect(result.finding).toContain("checksum");
  });
});
