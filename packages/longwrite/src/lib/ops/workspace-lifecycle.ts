import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { packageRoot } from "../paths.js";
import { loadProjectConfig } from "../project-config.js";

const execFileAsync = promisify(execFile);
const RETENTION_PATH = "reports/retention.json";
const PROVENANCE_DIR = "reports/run-provenance";
const ARCHIVE_DIR = "archives";

const CANONICAL_ARCHIVE_PATHS = [
  "longwrite.yaml", "malaclaw.yaml", "project_brief.md", "chapters", "paper", "build/manuscript.pdf",
  "sources", "fulltext", "evidence", "codebases/manifest.json", "figures", "tables", "reviews", "reports", ".malaclaw/flow",
] as const;

const FINAL_OUTPUT_PATHS = [
  "build/manuscript.pdf", "build/manuscript.tex", "paper/main.tex", "paper/references.bib",
  "sources/bibliography.bib", "sources/classified_sources.jsonl", "sources/citation_plan.jsonl",
  "evidence/citation-ledger.jsonl", "evidence/chunks.jsonl", "evidence/source-packets.json",
  "codebases/manifest.json",
  "reports/corpus-gates.json", "reports/longwrite-validation.md",
] as const;

const PRUNABLE_EXACT_PATHS = ["evidence/index.sqlite"] as const;
const PRUNABLE_SUFFIXES = [".aux", ".log", ".out", ".toc", ".fls", ".fdb_latexmk", ".synctex.gz"] as const;

export type ProvenanceOptions = { runtime?: string };

type FileDigest = { path: string; sha256: string; bytes: number };

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function statOrNull(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileDigest(root: string, rel: string): Promise<FileDigest | null> {
  const abs = path.join(root, rel);
  const stat = await statOrNull(abs);
  if (!stat || !stat.isFile()) return null;
  return { path: rel, sha256: sha256(await fs.readFile(abs)), bytes: Number(stat.size) };
}

async function filesUnder(root: string, rel: string): Promise<string[]> {
  const abs = path.join(root, rel);
  const stat = await statOrNull(abs);
  if (!stat) return [];
  if (stat.isFile()) return [rel];
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesUnder(root, path.join(rel, entry.name))));
  return nested.flat();
}

async function commandText(command: string, args: string[], cwd?: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, args, { cwd, encoding: "utf8" });
    return result.stdout.trim() || result.stderr.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitIdentity(root: string): Promise<{ revision?: string; dirty?: boolean }> {
  const revision = await commandText("git", ["rev-parse", "HEAD"], root);
  if (!revision) return {};
  const status = await commandText("git", ["status", "--porcelain"], root);
  return { revision, dirty: Boolean(status) };
}

async function packageVersion(root: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

function malaclawCommand(): string {
  return process.env.LONGWRITE_MALACLAW_BIN ?? "malaclaw";
}

async function commandVersion(command: string): Promise<string | undefined> {
  return commandText(command, ["--version"]);
}

function modelPolicy(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== "object") return undefined;
  const workflow = (manifest as { workflow?: unknown }).workflow;
  if (!workflow || typeof workflow !== "object") return undefined;
  const record = workflow as Record<string, unknown>;
  return {
    runtime_policy: record.runtime_policy,
    model_tiers: record.model_tiers,
  };
}

async function actualFlowUnits(root: string): Promise<Array<{ key: string; status?: string; requested_runtime?: string; actual_runtime?: string; requested_model?: string; actual_model?: string; attempts?: number }>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, ".malaclaw", "flow", "state.json"), "utf8")) as { units?: unknown };
    if (!raw.units || typeof raw.units !== "object") return [];
    return Object.entries(raw.units as Record<string, unknown>).flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return [];
      const unit = value as Record<string, unknown>;
      const text = (field: string): string | undefined => typeof unit[field] === "string" ? unit[field] : undefined;
      const attempts = typeof unit.attempts === "number" ? unit.attempts : undefined;
      return [{ key, status: text("status"), requested_runtime: text("requestedRuntime"), actual_runtime: text("actualRuntime"), requested_model: text("requestedModel"), actual_model: text("actualModel"), attempts }];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // MalaClaw has already reported workflow success before LongWrite records
    // provenance. A damaged optional state snapshot must not retroactively
    // turn that successful run into a CLI failure; record provenance without
    // per-unit runtime details and leave the snapshot for operator repair.
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function publicationProvenanceSummary(workspaceDir: string): Promise<{ longwrite?: string; malaclaw?: string; runtime_models: string[] }> {
  const root = path.resolve(workspaceDir);
  const longwriteVersion = await packageVersion(packageRoot());
  const longwriteGit = await gitIdentity(packageRoot());
  const shortRevision = longwriteGit.revision?.slice(0, 12);
  const malaclawVersion = await commandVersion(malaclawCommand());
  const units = await actualFlowUnits(root);
  const grouped = new Map<string, number>();
  for (const unit of units) {
    const runtime = unit.actual_runtime ?? unit.requested_runtime;
    if (!runtime || runtime === "script" || runtime === "dry-run") continue;
    const model = unit.actual_model ?? unit.requested_model ?? "runtime default (unpinned)";
    const key = `${runtime} | ${model}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return {
    ...(longwriteVersion ? { longwrite: `LongWrite ${longwriteVersion}${shortRevision ? ` (${shortRevision})` : ""}` } : {}),
    ...(malaclawVersion ? { malaclaw: malaclawVersion } : {}),
    runtime_models: [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key} (${count} unit${count === 1 ? "" : "s"})`),
  };
}

/** Write an append-only run record. It deliberately stores capability names
 * and model policy, never API keys or workspace .env contents. */
export async function writeRunProvenance(workspaceDir: string, options: ProvenanceOptions = {}): Promise<string> {
  const root = path.resolve(workspaceDir);
  const configPath = path.join(root, "longwrite.yaml");
  const manifestPath = path.join(root, "malaclaw.yaml");
  const [configRaw, manifestRaw, config] = await Promise.all([
    fs.readFile(configPath, "utf8"),
    fs.readFile(manifestPath, "utf8"),
    loadProjectConfig(root),
  ]);
  const manifest = parseYaml(manifestRaw);
  const outputDigests = (await Promise.all(FINAL_OUTPUT_PATHS.map((rel) => fileDigest(root, rel)))).filter((item): item is FileDigest => item !== null);
  const corpusInputs = outputDigests.filter((item) => item.path.startsWith("sources/") || item.path.startsWith("evidence/"));
  const malaclawSource = process.env.MALACLAW_SOURCE_DIR ? path.resolve(process.env.MALACLAW_SOURCE_DIR) : undefined;
  const record = {
    version: 1,
    kind: "longwrite-run-provenance",
    created_at: new Date().toISOString(),
    workspace: { project_id: config.project.id, mode: config.project.mode, artifact_type: config.project.artifact_type },
    inputs: {
      longwrite_yaml_sha256: sha256(configRaw),
      malaclaw_yaml_sha256: sha256(manifestRaw),
      corpus_sha256: sha256(JSON.stringify(corpusInputs.map(({ path: rel, sha256: digest }) => ({ path: rel, sha256: digest })))),
    },
    longwrite: { version: await packageVersion(packageRoot()), ...(await gitIdentity(packageRoot())) },
    malaclaw: {
      command: malaclawCommand(),
      version: await commandVersion(malaclawCommand()),
      ...(malaclawSource ? { source_dir: malaclawSource, ...(await gitIdentity(malaclawSource)) } : {}),
    },
    execution: {
      requested_runtime: options.runtime ?? "default",
      runtime_profile: config.runtime_profile ?? "default",
      research_provider: config.research.provider,
      model_policy: modelPolicy(manifest),
      units: await actualFlowUnits(root),
    },
    outputs: outputDigests,
  };
  const rel = `${PROVENANCE_DIR}/${stamp()}.json`;
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return rel;
}

export async function markWorkspaceKeep(workspaceDir: string, note?: string): Promise<string> {
  const root = path.resolve(workspaceDir);
  const record = { version: 1, policy: "keep", updated_at: new Date().toISOString(), ...(note?.trim() ? { note: note.trim() } : {}) };
  await fs.mkdir(path.join(root, "reports"), { recursive: true });
  await fs.writeFile(path.join(root, RETENTION_PATH), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return RETENTION_PATH;
}

async function runTar(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync("tar", args, { cwd, encoding: "utf8" });
  } catch (error) {
    throw new Error(`Archive command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function archiveWorkspace(workspaceDir: string): Promise<{ archive: string; manifest: string; provenance: string }> {
  const root = path.resolve(workspaceDir);
  const provenance = await writeRunProvenance(root);
  const included: string[] = [];
  for (const rel of CANONICAL_ARCHIVE_PATHS) {
    if (await statOrNull(path.join(root, rel))) included.push(rel);
  }
  if (included.length === 0) throw new Error("Workspace has no archiveable artifacts");
  await fs.mkdir(path.join(root, ARCHIVE_DIR), { recursive: true });
  const base = `longwrite-${stamp()}`;
  const archiveRel = `${ARCHIVE_DIR}/${base}.tar.gz`;
  await runTar(["-czf", archiveRel, ...included], root);
  const archiveDigest = await fileDigest(root, archiveRel);
  if (!archiveDigest) throw new Error("Archive was not created");
  const files = (await Promise.all((await Promise.all(included.map((rel) => filesUnder(root, rel)))).flat().map((rel) => fileDigest(root, rel)))).filter((item): item is FileDigest => item !== null);
  const manifestRel = `${ARCHIVE_DIR}/${base}.manifest.json`;
  const manifest = { version: 1, kind: "longwrite-verified-archive", created_at: new Date().toISOString(), archive: archiveDigest, provenance, files };
  await fs.writeFile(path.join(root, manifestRel), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { archive: archiveRel, manifest: manifestRel, provenance };
}

async function verifiedArchive(root: string, archiveRel?: string): Promise<string> {
  const archive = archiveRel ?? (await fs.readdir(path.join(root, ARCHIVE_DIR)).catch(() => []))
    .filter((name) => name.endsWith(".tar.gz")).sort().at(-1);
  if (!archive) throw new Error("Prune requires a verified archive. Run `longwrite workspace archive <workspace>` first.");
  const normalized = archive.startsWith(`${ARCHIVE_DIR}/`) ? archive : `${ARCHIVE_DIR}/${archive}`;
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) throw new Error("--archive must be an archive path inside this workspace");
  const manifestRel = normalized.replace(/\.tar\.gz$/, ".manifest.json");
  let manifest: { archive?: FileDigest };
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, manifestRel), "utf8")) as { archive?: FileDigest };
  } catch {
    throw new Error(`Archive manifest is missing: ${manifestRel}`);
  }
  const digest = await fileDigest(root, normalized);
  if (!digest || !manifest.archive || digest.sha256 !== manifest.archive.sha256 || digest.bytes !== manifest.archive.bytes) {
    throw new Error(`Archive verification failed: ${normalized}`);
  }
  return normalized;
}

async function pruneCandidates(root: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const rel of PRUNABLE_EXACT_PATHS) {
    if (await statOrNull(path.join(root, rel))) candidates.push(rel);
  }
  for (const base of ["build", "paper"]) {
    for (const rel of await filesUnder(root, base)) {
      if (PRUNABLE_SUFFIXES.some((suffix) => rel.endsWith(suffix))) candidates.push(rel);
    }
  }
  return [...new Set(candidates)].sort();
}

export async function pruneWorkspace(workspaceDir: string, options: { execute?: boolean; archive?: string } = {}): Promise<{ dryRun: boolean; archive?: string; candidates: string[]; report: string }> {
  const root = path.resolve(workspaceDir);
  const candidates = await pruneCandidates(root);
  const archive = options.execute ? await verifiedArchive(root, options.archive) : undefined;
  if (options.execute) await Promise.all(candidates.map((rel) => fs.rm(path.join(root, rel), { force: true })));
  const rel = `reports/prune-${stamp()}.json`;
  const report = { version: 1, kind: "longwrite-prune", created_at: new Date().toISOString(), dry_run: !options.execute, ...(archive ? { verified_archive: archive } : {}), candidates, removed: options.execute ? candidates : [] };
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { dryRun: !options.execute, archive, candidates, report: rel };
}
