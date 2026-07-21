import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ExperimentEvidencePacket, PublicationExperimentManifest } from "@mr-maliang/research-protocol";
import { loadProjectConfig } from "../project-config.js";
import { loadCodebaseManifest } from "./codebase-contract.js";

/** LongWrite deliberately parses the complete public LongExperiment result
 * contract rather than accepting a boolean produced by another process. */
export const LongExperimentManifest = PublicationExperimentManifest;
export type LongExperimentManifest = z.infer<typeof LongExperimentManifest>;

type ImportedArtifact = { id: string; kind: "figure" | "table"; source_path: string; imported_path: string; sha256: string };
type ArtifactBundle = { version: 1; source_manifest_sha256: string; source_workspace: string; artifacts: ImportedArtifact[] };

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
async function exists(filePath: string): Promise<boolean> { try { await fs.access(filePath); return true; } catch { return false; } }
function safeRel(rel: string): boolean { return rel.length > 0 && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."); }
function sameRevision(left: string, right: string): boolean { return left === right || left.startsWith(right) || right.startsWith(left); }

async function readManifest(manifestPath: string): Promise<LongExperimentManifest> {
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const manifest = LongExperimentManifest.parse(raw);
  if (manifest.trial_count !== manifest.trials.length) throw new Error("LongExperiment manifest trial_count does not match its completed trial records");
  const ids = new Set(manifest.trials.map((trial) => trial.id));
  if (ids.size !== manifest.trials.length) throw new Error("LongExperiment manifest contains duplicate trial IDs");
  return manifest;
}

function sourceRoot(manifestPath: string): string { return path.dirname(path.dirname(path.resolve(manifestPath))); }

async function copyArtifact(sourceRootDir: string, workspaceDir: string, kind: "figure" | "table", rel: string, index: number): Promise<ImportedArtifact> {
  if (!safeRel(rel)) throw new Error(`LongExperiment artifact path is unsafe: ${rel}`);
  const source = path.join(sourceRootDir, rel);
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error(`LongExperiment artifact is missing or empty: ${rel}`);
  const ext = path.extname(rel) || (kind === "figure" ? ".bin" : ".csv");
  const id = `${kind}-${index + 1}-${path.basename(rel, ext).replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const targetRel = `experiments/imported/${id}${ext}`;
  await fs.mkdir(path.dirname(path.join(workspaceDir, targetRel)), { recursive: true });
  await fs.copyFile(source, path.join(workspaceDir, targetRel));
  return { id, kind, source_path: rel, imported_path: targetRel, sha256: sha256(await fs.readFile(source)) };
}

/** Import canonical result data and figures into the paper workspace. Files
 * are copied, never linked, so the paper package stays reproducible after the
 * experiment workspace moves or is archived. */
export async function importLongExperiment(workspaceDir: string, manifestPath: string): Promise<{ manifestPath: string; bundlePath: string }> {
  const source = path.resolve(manifestPath);
  const sourceDir = sourceRoot(source);
  const manifest = await readManifest(source);
  const rawResult = path.join(sourceDir, manifest.artifacts.results_json);
  if (!safeRel(manifest.artifacts.results_json) || !await exists(rawResult)) throw new Error("LongExperiment result JSON is missing");
  if (sha256(await fs.readFile(rawResult)) !== manifest.provenance.result_sha256) throw new Error("LongExperiment result JSON checksum does not match its manifest");
  const targetManifest = path.join(workspaceDir, "experiments", "longexperiment-manifest.json");
  await fs.mkdir(path.dirname(targetManifest), { recursive: true });
  await fs.copyFile(source, targetManifest);
  const artifacts = [
    ...await Promise.all(manifest.artifacts.figures.map((rel, index) => copyArtifact(sourceDir, workspaceDir, "figure", rel, index))),
    ...await Promise.all(manifest.artifacts.tables.map((rel, index) => copyArtifact(sourceDir, workspaceDir, "table", rel, index))),
  ];
  const bundle: ArtifactBundle = { version: 1, source_manifest_sha256: sha256(await fs.readFile(source)), source_workspace: sourceDir, artifacts };
  const bundlePath = path.join(workspaceDir, "experiments", "artifact-bundle.json");
  await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { manifestPath: "experiments/longexperiment-manifest.json", bundlePath: "experiments/artifact-bundle.json" };
}

async function codebaseBinding(workspaceDir: string, manifest: LongExperimentManifest, codebaseId?: string, inputId?: string): Promise<{ pass: boolean; finding: string }> {
  if (!codebaseId) return { pass: true, finding: "no repository binding configured" };
  const codebases = await loadCodebaseManifest(workspaceDir);
  const codebase = codebases?.codebases.find((item) => item.id === codebaseId);
  if (!codebase?.resolved_commit) return { pass: false, finding: `configured codebase ${codebaseId} has no pinned snapshot` };
  const resolvedCommit = codebase.resolved_commit;
  const candidates = inputId ? [manifest.provenance.input_revisions[inputId]] : Object.values(manifest.provenance.input_revisions);
  if (!candidates.some((revision) => typeof revision === "string" && sameRevision(revision, resolvedCommit))) {
    return { pass: false, finding: `LongExperiment input revision does not match pinned codebase ${codebaseId} (${resolvedCommit})` };
  }
  return { pass: true, finding: `experiment input revision matches pinned codebase ${codebaseId}` };
}

/** Convert audited comparisons into a bounded evidence packet. This is the
 * only empirical context injected into outlining, drafting, visual planning,
 * and review; models never read arbitrary runner logs as result evidence. */
export async function prepareExperimentEvidence(workspaceDir: string): Promise<string[]> {
  const config = await loadProjectConfig(workspaceDir);
  const experiment = config.research.experiment;
  if (config.research.paper_kind !== "empirical" || !experiment.enabled || !experiment.manifest_path) throw new Error("empirical evidence preparation requires research.experiment.enabled and manifest_path");
  const rel = experiment.manifest_path;
  if (!safeRel(rel)) throw new Error("research.experiment.manifest_path must stay inside the paper workspace");
  const manifestPath = path.join(workspaceDir, rel);
  const manifest = await readManifest(manifestPath);
  if (manifest.trial_count < experiment.min_trials) throw new Error(`experiment has ${manifest.trial_count} trials; configured minimum is ${experiment.min_trials}`);
  const bundlePath = path.join(workspaceDir, "experiments", "artifact-bundle.json");
  const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8")) as ArtifactBundle;
  if (bundle.version !== 1 || bundle.source_manifest_sha256 !== sha256(await fs.readFile(manifestPath))) throw new Error("experiment artifact bundle does not match the imported manifest");
  for (const artifact of bundle.artifacts) {
    const full = path.join(workspaceDir, artifact.imported_path);
    if (!safeRel(artifact.imported_path) || !await exists(full) || sha256(await fs.readFile(full)) !== artifact.sha256) throw new Error(`imported experiment artifact failed checksum verification: ${artifact.imported_path}`);
  }
  const binding = await codebaseBinding(workspaceDir, manifest, experiment.codebase_id, experiment.input_id);
  if (!binding.pass) throw new Error(binding.finding);
  const packet = ExperimentEvidencePacket.parse({
    version: 1, manifest_path: rel, manifest_sha256: sha256(await fs.readFile(manifestPath)), hypothesis: manifest.hypothesis,
    trial_count: manifest.trial_count, statistical_test: manifest.statistical_test, metrics: manifest.metrics,
    codebase_binding: binding, provenance: manifest.provenance,
    comparisons: manifest.comparisons.map((comparison) => ({ ...comparison, claim: `${comparison.treatment_condition} versus ${comparison.baseline_condition} changed ${comparison.metric} by ${comparison.estimate} with ${comparison.confidence_interval.level * 100}% CI [${comparison.confidence_interval.lower}, ${comparison.confidence_interval.upper}] over paired seeds ${comparison.paired_seeds.join(", ")}.` })),
    artifacts: bundle.artifacts,
  });
  await fs.mkdir(path.join(workspaceDir, "evidence"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "evidence", "experiment-packets.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(workspaceDir, "experiments", "verification.json"), `${JSON.stringify({ version: 1, pass: true, manifest_sha256: packet.manifest_sha256, binding, artifacts_verified: bundle.artifacts.length, verified_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return ["evidence/experiment-packets.json", "experiments/verification.json"];
}

export async function validateImportedExperiment(workspaceDir: string): Promise<{ pass: boolean; finding: string }> {
  try {
    await prepareExperimentEvidence(workspaceDir);
    return { pass: true, finding: "complete LongExperiment manifest, checksummed artifacts, trials, comparisons, and repository binding verified" };
  } catch (error) {
    return { pass: false, finding: error instanceof Error ? error.message : String(error) };
  }
}
