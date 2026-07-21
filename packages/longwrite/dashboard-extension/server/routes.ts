import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type LongWriteDashboardHost = {
  loadFlowState: (workspaceDir: string) => Promise<unknown>;
  logsDir: (workspaceDir: string) => string;
  approveAllFlow: (workspaceDir: string) => Promise<unknown>;
  approveFlow: (workspaceDir: string, approvalId: string) => Promise<unknown>;
  summarizeUsage: (workspaceDir: string) => Promise<unknown>;
};

type FastifyLike = {
  get: (path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) => void;
  post: (path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) => void;
};

type YamlRecord = Record<string, unknown>;

type StageSummary = {
  id: string;
  title?: string;
  type: "standard" | "foreach" | "loop";
  effectiveRuntime?: string;
  effectiveModel?: string;
  locked?: boolean;
  maxRounds?: number;
  stopWhen?: string;
  children?: StageSummary[];
  owner?: string;
  runtime?: string;
  model?: string;
  modelTier?: string;
  requiresHumanApproval: boolean;
  enabled: boolean;
  skippable: boolean;
  maxParallel?: number;
  steps: Array<{ id: string; owner?: string; runtime?: string; model?: string; modelTier?: string }>;
  outputs: string[];
};

type ProjectConfig = YamlRecord & {
  version?: unknown;
  project?: YamlRecord;
  runtime_profile?: unknown;
  research?: YamlRecord;
  writing?: YamlRecord;
  review?: YamlRecord;
  execution?: YamlRecord;
};

type StagePatch = {
  dir?: string;
  stageId?: string;
  runtime?: string | null;
  model?: string | null;
  modelTier?: string | null;
  requiresHumanApproval?: boolean;
  enabled?: boolean;
  maxParallel?: number | null;
};

const LOG_TAIL_BYTES = 10_000;
const MAX_OPERATION_OUTPUT = 20_000;
const MAX_RUN_OUTPUT = 40_000;
const MAX_APPROVAL_ARTIFACT_BYTES = 250_000;
const MAX_CURRENT_ARTIFACT_BYTES = 500_000;

type CurrentArtifact = { path: string; kind: "pdf" | "text" };

export type ResolvedWritingWorkspace = {
  /** The directory selected by the operator in the dashboard. */
  requestedDir: string;
  /** The LongWrite component directory that owns longwrite.yaml. */
  workspaceDir: string;
  /** The enclosing MrMaLiang research-program directory, when present. */
  parentWorkspace: string | null;
};

export type BrowseFolder = {
  name: string;
  path: string;
  kind: "folder" | "maliang_workspace" | "writing_workspace";
};

export type BrowseFoldersResult = {
  path: string;
  parent: string | null;
  folders: BrowseFolder[];
};

function isCurrentArtifactPath(value: string): boolean {
  return value === "build/manuscript.pdf"
    || value === "build/manuscript.tex"
    || value === "reports/metrics.json"
    || value === "reports/routing.md"
    || value === "reports/latex-build.md"
    || value === "reports/action-plan-repair.md"
    || value === "reports/codebase-analysis-repair.md"
    || value === "reports/action-dispatch.json"
    || value === "evidence/codebase-analysis.json"
    || value === "reviews/action-plan.json"
    || value === "reviews/clarification-request.md"
    || value === "reviews/revision-report.md"
    || /^reviews\/review-round-\d{3}\.md$/.test(value)
    || /^chapters\/[A-Za-z0-9._-]+\.md$/.test(value);
}

async function currentArtifacts(workspaceDir: string): Promise<CurrentArtifact[]> {
  const fixed: CurrentArtifact[] = [
    { path: "build/manuscript.pdf", kind: "pdf" },
    { path: "build/manuscript.tex", kind: "text" },
    { path: "reports/metrics.json", kind: "text" },
    { path: "reports/routing.md", kind: "text" },
    { path: "reports/latex-build.md", kind: "text" },
    { path: "reports/action-plan-repair.md", kind: "text" },
    { path: "reports/codebase-analysis-repair.md", kind: "text" },
    { path: "reports/action-dispatch.json", kind: "text" },
    { path: "evidence/codebase-analysis.json", kind: "text" },
    { path: "reviews/action-plan.json", kind: "text" },
    { path: "reviews/clarification-request.md", kind: "text" },
    { path: "reviews/revision-report.md", kind: "text" },
  ];
  const available: CurrentArtifact[] = [];
  for (const artifact of fixed) {
    try {
      await fs.access(path.join(workspaceDir, artifact.path));
      available.push(artifact);
    } catch {
      // The artifact has not been produced yet.
    }
  }
  try {
    const chapters = (await fs.readdir(path.join(workspaceDir, "chapters")))
      .filter((name) => /^[A-Za-z0-9._-]+\.md$/.test(name))
      .sort()
      .map((name) => ({ path: `chapters/${name}`, kind: "text" as const }));
    available.push(...chapters);
  } catch {
    // No chapter directory yet.
  }
  try {
    const reviewRounds = (await fs.readdir(path.join(workspaceDir, "reviews")))
      .filter((name) => /^review-round-\d{3}\.md$/.test(name))
      .sort()
      .map((name) => ({ path: `reviews/${name}`, kind: "text" as const }));
    available.push(...reviewRounds);
  } catch {
    // The first review has not been produced yet.
  }
  return available;
}

type RunRecord = {
  running: boolean;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  args: string[];
  stdout: string;
  stderr: string;
};

const runRegistry = new Map<string, RunRecord>();

async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function readYamlIfExists(absPath: string): Promise<YamlRecord | null> {
  const raw = await readTextIfExists(absPath);
  if (raw === null) return null;
  const parsed = parseYaml(raw);
  return typeof parsed === "object" && parsed !== null ? (parsed as YamlRecord) : {};
}

async function readJsonIfExists(absPath: string): Promise<YamlRecord | null> {
  const raw = await readTextIfExists(absPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as YamlRecord : null;
  } catch {
    return null;
  }
}

async function evidenceSummary(workspaceDir: string): Promise<YamlRecord> {
  const [manifest, coverage, ledger, fulltext, upgrades, verification] = await Promise.all([
    readJsonIfExists(path.join(workspaceDir, "evidence", "manifest.json")),
    readJsonIfExists(path.join(workspaceDir, "evidence", "coverage.json")),
    readTextIfExists(path.join(workspaceDir, "evidence", "citation-ledger.jsonl")),
    readJsonIfExists(path.join(workspaceDir, "fulltext", "manifest.json")),
    readTextIfExists(path.join(workspaceDir, "sources", "metadata-upgrades.jsonl")),
    readTextIfExists(path.join(workspaceDir, "sources", "citation-verification.jsonl")),
  ]);
  const jsonlStatuses = (raw: string | null): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const line of raw?.split("\n").filter(Boolean) ?? []) {
      try {
        const status = asString(JSON.parse(line).status);
        if (status) counts[status] = (counts[status] ?? 0) + 1;
      } catch {
        counts.invalid = (counts.invalid ?? 0) + 1;
      }
    }
    return counts;
  };
  const fulltextResults = Array.isArray(fulltext?.results) ? fulltext.results.map(asRecord) : [];
  return {
    indexed: manifest !== null,
    chunks: asNumber(manifest?.chunks) ?? 0,
    sources: asNumber(manifest?.sources_indexed) ?? 0,
    sections: asNumber(coverage?.sections) ?? 0,
    taxonomy: Array.isArray(coverage?.taxonomy) ? coverage?.taxonomy : [],
    ledgerEntries: ledger ? ledger.split("\n").filter(Boolean).length : 0,
    fulltext: Object.fromEntries(["ingested", "skipped", "failed"].map((status) => [status, fulltextResults.filter((result) => asString(result.status) === status).length])),
    upgrades: jsonlStatuses(upgrades),
    urlVerification: jsonlStatuses(verification),
  };
}

function requireDir(dir: unknown): string {
  if (typeof dir !== "string" || dir.length === 0 || !path.isAbsolute(dir)) {
    throw Object.assign(new Error("dir must be an absolute workspace path"), { statusCode: 400 });
  }
  return dir;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve both supported dashboard selections:
 *
 * - a component directory containing longwrite.yaml (legacy/direct use), or
 * - a MrMaLiang program directory containing maliang.yaml + writing/.
 *
 * The UI keeps the operator-selected directory so all commands and displayed
 * paths stay at the public MrMaLiang level, while component operations use the
 * resolved LongWrite directory internally.
 */
export async function resolveWritingWorkspace(dir: unknown): Promise<ResolvedWritingWorkspace> {
  const requestedDir = requireDir(dir);
  if (await pathExists(path.join(requestedDir, "longwrite.yaml"))) {
    return { requestedDir, workspaceDir: requestedDir, parentWorkspace: await maliangParent(requestedDir) };
  }

  const project = await readYamlIfExists(path.join(requestedDir, "maliang.yaml"));
  const writing = asRecord(asRecord(project?.components).writing);
  const configuredWorkspace = asString(writing.workspace) ?? "writing";
  const workspaceDir = path.resolve(requestedDir, configuredWorkspace);
  if (await pathExists(path.join(workspaceDir, "longwrite.yaml"))) {
    return { requestedDir, workspaceDir, parentWorkspace: requestedDir };
  }
  return { requestedDir, workspaceDir: requestedDir, parentWorkspace: null };
}

/**
 * Directory discovery is deliberately narrow: it only enumerates directories
 * below a chosen root (the local account home by default), never file content.
 * That makes the dashboard picker useful without becoming a general file-read
 * API capable of exposing .env files or arbitrary project documents.
 */
export async function browseWorkspaceFolders(dir?: unknown, rootDir = os.homedir()): Promise<BrowseFoldersResult> {
  const root = await fs.realpath(path.resolve(rootDir));
  const requested = dir === undefined || dir === null || dir === "" ? root : requireDir(dir);
  let selected: string;
  try {
    selected = await fs.realpath(requested);
  } catch {
    throw Object.assign(new Error(`directory not found: ${requested}`), { statusCode: 404 });
  }
  if (!isWithin(root, selected)) {
    throw Object.assign(new Error("folder browsing is limited to the configured local workspace root"), { statusCode: 403 });
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(selected, { withFileTypes: true });
  } catch (err) {
    throw Object.assign(new Error(`cannot read directory: ${err instanceof Error ? err.message : String(err)}`), { statusCode: 400 });
  }
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 250);
  const folders = await Promise.all(directories.map(async (entry): Promise<BrowseFolder> => {
    const child = path.join(selected, entry.name);
    const [isProgram, isWriting] = await Promise.all([
      pathExists(path.join(child, "maliang.yaml")),
      pathExists(path.join(child, "longwrite.yaml")),
    ]);
    return {
      name: entry.name,
      path: child,
      kind: isProgram ? "maliang_workspace" : isWriting ? "writing_workspace" : "folder",
    };
  }));
  return {
    path: selected,
    parent: selected === root ? null : path.dirname(selected),
    folders,
  };
}

function asRecord(value: unknown): YamlRecord {
  return typeof value === "object" && value !== null ? (value as YamlRecord) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Inputs that define the evidence program, rather than ordinary presentation
 * or runtime preferences. Once source work has begun, changing any of these
 * would make the existing corpus and review state misleading. */
export function evidenceProgramFingerprint(value: unknown): string {
  const config = asRecord(value);
  const research = asRecord(config.research);
  const writing = asRecord(config.writing);
  const codebases = Array.isArray(research.codebases)
    ? research.codebases.map(asRecord).map((entry) => ({
      id: asString(entry.id) ?? "",
      source: asString(entry.source) ?? "",
      ref: asString(entry.ref) ?? "HEAD",
      role: asString(entry.role) ?? "",
    }))
    : [];
  return JSON.stringify({
    topic: asString(research.topic) ?? "",
    codebases,
    referenceLinks: asStringArray(writing.reference_links),
  });
}

function hasStartedFlow(flow: unknown): boolean {
  const status = asString(asRecord(flow).status);
  return status !== undefined && status !== "not_started";
}

function asAuthors(value: unknown): Array<{ name: string; email?: string }> {
  return Array.isArray(value)
    ? value.map(asRecord).map((author) => ({
      name: asString(author.name) ?? "",
      email: asString(author.email),
    })).filter((author) => author.name.length > 0)
    : [];
}

function stageOutputs(stage: YamlRecord): string[] {
  const outputs = asStringArray(stage.outputs);
  const steps = Array.isArray(stage.steps) ? stage.steps.map(asRecord) : [];
  return [...new Set([...outputs, ...steps.flatMap((step) => asStringArray(step.outputs))])];
}

/** Effective runtime/model, resolved exactly like the engine:
 *  unit override -> model_tier -> runtime_policy.primary -> CLI default. */
function resolveEffective(
  unit: YamlRecord,
  workflow: YamlRecord,
): { effectiveRuntime: string; effectiveModel?: string; locked: boolean } {
  const tiers = asRecord(workflow.model_tiers);
  const tier = asString(unit.model_tier) ? asRecord(tiers[asString(unit.model_tier)!]) : undefined;
  const effectiveRuntime =
    asString(unit.runtime)
    ?? (tier ? asString(tier.runtime) : undefined)
    ?? asString(asRecord(workflow.runtime_policy).primary)
    ?? "default runtime (CLI --runtime)";
  const effectiveModel = asString(unit.model) ?? (tier ? asString(tier.model) : undefined);
  // Deterministic script stages are locked: their command IS the behavior.
  const locked = asString(unit.runtime) === "script" && unit.command !== undefined;
  return { effectiveRuntime, effectiveModel, locked };
}

function summarizeStage(stage: YamlRecord, workflow: YamlRecord): StageSummary {
  const steps = Array.isArray(stage.steps)
    ? stage.steps.map(asRecord).map((step) => ({
        id: asString(step.id) ?? "unknown",
        owner: asString(step.owner),
        runtime: asString(step.runtime),
        model: asString(step.model),
        modelTier: asString(step.model_tier),
        ...resolveEffective(step, workflow),
      }))
    : [];
  // Loop children are REAL executable nodes, not hidden inside the parent.
  const children = Array.isArray(stage.stages)
    ? stage.stages.map(asRecord).map((child) => summarizeStage(child, workflow))
    : [];
  const type = children.length > 0 ? "loop" : steps.length > 0 || asString(stage.type) === "foreach" ? "foreach" : "standard";
  return {
    id: asString(stage.id) ?? "unknown",
    title: asString(stage.title),
    type,
    owner: asString(stage.owner),
    runtime: asString(stage.runtime),
    model: asString(stage.model),
    modelTier: asString(stage.model_tier),
    requiresHumanApproval: asBoolean(stage.requires_human_approval),
    enabled: stage.enabled !== false,
    skippable: asBoolean(stage.skippable),
    maxParallel: asNumber(stage.max_parallel),
    maxRounds: asNumber(stage.max_rounds),
    stopWhen: asString(stage.stop_when),
    steps,
    children,
    outputs: stageOutputs(stage),
    ...resolveEffective(stage, workflow),
  };
}

export function updateManifestStage(manifest: YamlRecord, patch: StagePatch): void {
  const workflow = asRecord(manifest.workflow);
  const stages = Array.isArray(workflow.stages) ? workflow.stages.map(asRecord) : [];
  const stage = stages.find((entry) => asString(entry.id) === patch.stageId);
  if (!stage) throw Object.assign(new Error(`stage "${patch.stageId}" not found`), { statusCode: 404 });

  // Truthful editing: reject edits the engine would ignore or misexecute,
  // BEFORE they reach the YAML.
  const reject = (message: string) => {
    throw Object.assign(new Error(message), { statusCode: 400 });
  };
  const isLoopParent = Array.isArray(stage.stages);
  const isForeach = Array.isArray(stage.steps) || asString(stage.type) === "foreach";
  const isLockedScript = asString(stage.runtime) === "script" && stage.command !== undefined;
  const touchesExecution =
    patch.runtime !== undefined || patch.model !== undefined || patch.modelTier !== undefined;
  if (isLoopParent && touchesExecution) {
    reject(`"${patch.stageId}" is a loop group: set runtime/model on its child stages, not the parent`);
  }
  if (isLoopParent && patch.requiresHumanApproval !== undefined) {
    reject(`"${patch.stageId}" is a loop group: approval gates belong to child stages, not the parent`);
  }
  if (isForeach && touchesExecution) {
    reject(`"${patch.stageId}" is a foreach group: execution settings belong to its inner steps and cannot be edited on the parent`);
  }
  if (isForeach && patch.requiresHumanApproval !== undefined) {
    reject(`"${patch.stageId}" is a foreach group: approval gates belong to inner steps and cannot be edited on the parent`);
  }
  if (isLockedScript && touchesExecution) {
    reject(`"${patch.stageId}" is a deterministic script stage; its command defines the behavior and runtime/model overrides are locked`);
  }
  if (patch.enabled === false && !asBoolean(stage.skippable)) {
    reject(`"${patch.stageId}" is not marked skippable by its LongWrite mode`);
  }
  if (patch.maxParallel !== undefined && patch.maxParallel !== null && !isForeach) {
    reject(`max_parallel is only valid on foreach stages; "${patch.stageId}" is ${isLoopParent ? "a loop" : "standard"}`);
  }
  if (patch.modelTier !== undefined && patch.modelTier !== null && patch.modelTier.trim().length > 0) {
    const tiers = Object.keys(asRecord(workflow.model_tiers));
    if (!tiers.includes(patch.modelTier.trim())) {
      reject(`model tier "${patch.modelTier}" is not defined; available: ${tiers.join(", ") || "none (this profile defines no tiers)"}`);
    }
  }

  const setOptionalString = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) delete stage[key];
    else stage[key] = trimmed;
  };
  setOptionalString("runtime", patch.runtime);
  setOptionalString("model", patch.model);
  setOptionalString("model_tier", patch.modelTier);
  if (patch.enabled !== undefined) {
    stage.enabled = patch.enabled;
    if (patch.enabled === false) stage.disabled_reason = "disabled by dashboard stage override";
    else delete stage.disabled_reason;
  }
  if (patch.requiresHumanApproval !== undefined) stage.requires_human_approval = patch.requiresHumanApproval;
  if (patch.maxParallel !== undefined) {
    if (patch.maxParallel === null) delete stage.max_parallel;
    else stage.max_parallel = patch.maxParallel;
  }
  workflow.stages = stages;
  manifest.workflow = workflow;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runCommand(workspaceDir: string, runtime?: string, parentWorkspace?: string | null): string {
  return parentWorkspace
    ? `maliang run ${shellQuote(parentWorkspace)}${runtime ? ` --runtime ${shellQuote(runtime)}` : ""}`
    : `maliang writing run ${shellQuote(workspaceDir)}${runtime ? ` --runtime ${shellQuote(runtime)}` : ""}`;
}

function approveCommand(workspaceDir: string, batchApprovals: boolean, parentWorkspace?: string | null): string {
  const target = parentWorkspace ?? workspaceDir;
  return batchApprovals ? `maliang writing approve ${shellQuote(target)} --batch` : `maliang writing status ${shellQuote(target)}`;
}

export function initArgs(body: {
  dir?: string;
  mode?: string;
  topic?: string;
  name?: string;
  authors?: Array<{ name?: string; email?: string }>;
  targetLengthWords?: number;
  genre?: string;
  audience?: string;
  style?: string;
  runtimeProfile?: string;
  researchProvider?: string;
  researchWorkflowProfile?: string;
  reviewCadence?: string;
  reviewTime?: string;
  reviewIntervalHours?: number;
  batchApprovals?: boolean;
  referenceLinks?: string[];
  referenceFiles?: string[];
  repositories?: string[];
  discoverRepositories?: boolean;
  repositoryQueryBudget?: number;
  repositoryMaxCandidates?: number;
  repositoryMaxReadmes?: number;
  repositoryMaxSelected?: number;
  repositoryLanguages?: string[];
  includeArchivedRepositories?: boolean;
  allowUnlicensedRepositories?: boolean;
  outputFormats?: string[];
}): { targetDir: string; componentDir: string; args: string[] } {
  const targetDir = requireDir(body.dir);
  const template = body.mode === "novel" ? "writing.novel" : body.mode === "technical_book" ? "writing.technical-book" : "paper.survey";
  const args = ["init", targetDir, "--template", template];
  if (body.topic?.trim()) args.push("--topic", body.topic.trim());
  if (body.name?.trim()) args.push("--name", body.name.trim());
  const repositories = (body.repositories ?? []).map((value) => value.trim()).filter(Boolean);
  if (repositories.length > 0) args.push("--repository", ...repositories);
  if (body.discoverRepositories) args.push("--discover-repositories");
  const discoveryNumbers: Array<[string, number | undefined]> = [
    ["--repository-query-budget", body.repositoryQueryBudget],
    ["--repository-max-candidates", body.repositoryMaxCandidates],
    ["--repository-max-readmes", body.repositoryMaxReadmes],
    ["--repository-max-selected", body.repositoryMaxSelected],
  ];
  for (const [flag, value] of discoveryNumbers) if (value !== undefined) args.push(flag, String(value));
  const repositoryLanguages = (body.repositoryLanguages ?? []).map((value) => value.trim()).filter(Boolean);
  if (repositoryLanguages.length > 0) args.push("--repository-language", ...repositoryLanguages);
  if (body.includeArchivedRepositories) args.push("--include-archived-repositories");
  if (body.allowUnlicensedRepositories) args.push("--allow-unlicensed-repositories");
  const referenceLinks = (body.referenceLinks ?? []).map((value) => value.trim()).filter(Boolean);
  if (referenceLinks.length > 0) args.push("--reference-link", ...referenceLinks);
  args.push("--");
  const pairs: Array<[string, string | number | boolean | undefined]> = [
    ["--target-length-words", body.targetLengthWords],
    ["--genre", body.genre],
    ["--audience", body.audience],
    ["--style", body.style],
    ["--runtime-profile", body.runtimeProfile],
    ["--research-provider", body.researchProvider],
    ["--research-workflow-profile", body.researchWorkflowProfile],
    ["--review-cadence", body.reviewCadence],
    ["--review-time", body.reviewTime],
    ["--review-interval-hours", body.reviewIntervalHours],
  ];
  for (const [flag, value] of pairs) {
    if (value !== undefined && value !== "") args.push(flag, String(value));
  }
  if (body.batchApprovals) args.push("--batch-approvals");
  for (const author of body.authors ?? []) {
    if (author.name?.trim()) args.push("--author", author.name.trim());
    if (author.email?.trim()) args.push("--email", author.email.trim());
  }
  for (const file of body.referenceFiles ?? []) if (file.trim()) args.push("--reference-file", file.trim());
  const outputFormats = (body.outputFormats ?? []).map((value) => value.trim()).filter(Boolean);
  if (outputFormats.length > 0) args.push("--output-format", ...outputFormats);
  return { targetDir, componentDir: path.join(targetDir, "writing"), args };
}

async function recentLogs(host: LongWriteDashboardHost, workspaceDir: string): Promise<Array<{ name: string; content: string; truncated: boolean }>> {
  const dir = host.logsDir(workspaceDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.sort().slice(-3).map(async (name) => {
      const raw = await fs.readFile(path.join(dir, name), "utf-8");
      return {
        name,
        content: raw.slice(-LOG_TAIL_BYTES),
        truncated: raw.length > LOG_TAIL_BYTES,
      };
    }),
  );
  return entries;
}

function longwriteBin(): string {
  return process.env.MALACLAW_LONGWRITE_BIN ?? process.env.LONGWRITE_BIN ?? "longwrite";
}

function maliangBin(): string {
  return process.env.MALACLAW_MALIANG_BIN ?? process.env.MALIANG_BIN ?? "maliang";
}

async function validateProjectConfig(config: unknown): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-longwrite-config-"));
  try {
    await fs.writeFile(path.join(tempDir, "longwrite.yaml"), stringifyYaml(config), "utf-8");
    await runLongWrite(["validate", "config", tempDir], tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function runLongWrite(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(longwriteBin(), args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-MAX_OPERATION_OUTPUT);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_OPERATION_OUTPUT);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${longwriteBin()} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

function runMaliang(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(maliangBin(), args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-MAX_OPERATION_OUTPUT); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-MAX_OPERATION_OUTPUT); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${maliangBin()} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

async function maliangParent(workspaceDir: string): Promise<string | null> {
  const parent = path.dirname(workspaceDir);
  try {
    const project = await readYamlIfExists(path.join(parent, "maliang.yaml"));
    const components = asRecord(project?.components);
    const writing = asRecord(components.writing);
    const configured = asString(writing.workspace) ?? "writing";
    return path.resolve(parent, configured) === path.resolve(workspaceDir) ? parent : null;
  } catch {
    return null;
  }
}

function runStatus(workspaceDir: string): RunRecord | null {
  return runRegistry.get(workspaceDir) ?? null;
}

function appendTail(current: string, chunk: Buffer, maxBytes: number): string {
  return (current + chunk.toString()).slice(-maxBytes);
}

function spawnLongWriteRun(workspaceDir: string, parentWorkspace: string | null, opts: { runtime?: string; reset?: boolean }): RunRecord {
  const existing = runRegistry.get(workspaceDir);
  if (existing?.running) {
    throw Object.assign(new Error("LongWrite run is already active for this workspace"), { statusCode: 409 });
  }

  const args = parentWorkspace
    ? opts.reset
      ? ["writing", "run", parentWorkspace, ...(opts.runtime ? ["--runtime", opts.runtime] : []), "--reset"]
      : ["run", parentWorkspace, ...(opts.runtime ? ["--runtime", opts.runtime] : [])]
    : ["run", workspaceDir, ...(opts.runtime ? ["--runtime", opts.runtime] : []), ...(opts.reset ? ["--reset"] : [])];
  const child: ChildProcessWithoutNullStreams = spawn(parentWorkspace ? maliangBin() : longwriteBin(), args, { cwd: parentWorkspace ?? workspaceDir, shell: false });
  const record: RunRecord = {
    running: true,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    args,
    stdout: "",
    stderr: "",
  };
  runRegistry.set(workspaceDir, record);

  child.stdout.on("data", (chunk: Buffer) => {
    record.stdout = appendTail(record.stdout, chunk, MAX_RUN_OUTPUT);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    record.stderr = appendTail(record.stderr, chunk, MAX_RUN_OUTPUT);
  });
  child.on("error", (err) => {
    record.running = false;
    record.finishedAt = new Date().toISOString();
    record.stderr = appendTail(record.stderr, Buffer.from(err.message), MAX_RUN_OUTPUT);
  });
  child.on("close", (code, signal) => {
    record.running = false;
    record.finishedAt = new Date().toISOString();
    record.exitCode = code;
    record.signal = signal;
  });

  return record;
}

export function createLongWriteDashboardRoutes(host: LongWriteDashboardHost) {
  return async (app: FastifyLike) => {
  app.get("/api/longwrite", async (req, reply) => {
    const resolvedWorkspace = await resolveWritingWorkspace((req.query as { dir?: string }).dir);
    const { workspaceDir, parentWorkspace } = resolvedWorkspace;
    const longwrite = await readYamlIfExists(path.join(workspaceDir, "longwrite.yaml"));
    if (!longwrite) return reply.status(404).send({ error: "longwrite.yaml not found" });

    const manifest = await readYamlIfExists(path.join(workspaceDir, "malaclaw.yaml"));
    const project = asRecord(longwrite.project);
    const research = asRecord(longwrite.research);
    const writing = asRecord(longwrite.writing);
    const review = asRecord(longwrite.review);
    const workflow = asRecord(manifest?.workflow);
    const stages = Array.isArray(workflow.stages) ? workflow.stages.map(asRecord).map((stage) => summarizeStage(stage, workflow)) : [];
    const runtime = asString(manifest?.runtime) ?? asString(asRecord(workflow.runtime_policy).primary);
    const runLimits = workflow.run_limits !== undefined ? asRecord(workflow.run_limits) : null;
    const batchApprovals = review.batch_approvals === true;

    let flow = null;
    let usage = null;
    let logs: Array<{ name: string; content: string; truncated: boolean }> = [];
    try {
      flow = await host.loadFlowState(workspaceDir);
      usage = await host.summarizeUsage(workspaceDir);
      logs = await recentLogs(host, workspaceDir);
    } catch {
      flow = null;
      usage = null;
      logs = [];
    }

    return {
      dir: workspaceDir,
      requestedDir: resolvedWorkspace.requestedDir,
      parentWorkspace,
      config: longwrite,
      project: {
        id: asString(project.id),
        name: asString(project.name),
        mode: asString(project.mode) ?? asString(workflow.mode),
        artifactType: asString(project.artifact_type) ?? asString(workflow.artifact_type),
        runtimeProfile: asString(longwrite.runtime_profile) ?? "default",
        authors: asAuthors(project.authors),
      },
      research: {
        topic: asString(research.topic),
        provider: asString(research.provider),
        paperKind: asString(research.paper_kind),
        paperProfile: asString(research.paper_profile),
        targetCandidates: asNumber(research.target_candidates),
        queryBudget: asNumber(research.query_budget),
        taxonomy: asStringArray(research.taxonomy),
        codebases: Array.isArray(research.codebases) ? research.codebases.map(asRecord).map((entry) => ({
          id: asString(entry.id) ?? "unknown",
          source: asString(entry.source) ?? "",
          ref: asString(entry.ref) ?? "HEAD",
          title: asString(entry.title),
          role: asString(entry.role) ?? "primary_artifact",
        })) : [],
        codebaseDiscovery: (() => {
          const discovery = asRecord(research.codebase_discovery);
          return {
            enabled: asBoolean(discovery.enabled),
            queryBudget: asNumber(discovery.query_budget),
            maxCandidates: asNumber(discovery.max_candidates),
            maxReadmes: asNumber(discovery.max_readme_fetches),
            maxSelected: asNumber(discovery.max_selected),
          };
        })(),
      },
      writing: {
        targetLengthWords: asNumber(writing.target_length_words),
        genre: asString(writing.genre),
        audience: asString(writing.audience),
        styleInstructions: asString(writing.style_instructions),
        referenceLinks: asStringArray(writing.reference_links),
        referenceFiles: asStringArray(writing.reference_files),
        outputFormats: asStringArray(writing.output_formats),
      },
      review: {
        cadence: asString(review.cadence) ?? "manual",
        time: asString(review.time),
        intervalHours: asNumber(review.interval_hours),
        batchApprovals,
      },
      workflow: {
        runtime,
        budgetUsd: asNumber(workflow.budget_usd),
        runLimits,
        runtimePolicy: asRecord(workflow.runtime_policy),
        modelTiers: asRecord(workflow.model_tiers),
        stages,
      },
      flow,
      usage,
      logs,
      evidence: await evidenceSummary(workspaceDir),
      currentArtifacts: await currentArtifacts(workspaceDir),
      operation: runStatus(workspaceDir),
      commands: {
        status: parentWorkspace ? `maliang status ${shellQuote(parentWorkspace)}` : `maliang writing status ${shellQuote(workspaceDir)}`,
        run: runCommand(workspaceDir, runtime, parentWorkspace),
        approve: approveCommand(workspaceDir, batchApprovals, parentWorkspace),
        sync: `maliang writing sync ${shellQuote(parentWorkspace ?? workspaceDir)}`,
        words: `maliang writing metrics words ${shellQuote(parentWorkspace ?? workspaceDir)}`,
        packet: `maliang writing report packet ${shellQuote(parentWorkspace ?? workspaceDir)}`,
        feedback: `maliang writing feedback add ${shellQuote(parentWorkspace ?? workspaceDir)} --message ${shellQuote("...")}`,
      },
    };
  });

  app.get("/api/longwrite/folders", async (req, reply) => {
    try {
      return await browseWorkspaceFolders((req.query as { dir?: string }).dir);
    } catch (err) {
      const statusCode = typeof err === "object" && err !== null && "statusCode" in err
        ? Number((err as { statusCode?: number }).statusCode)
        : 500;
      return reply.status(Number.isFinite(statusCode) ? statusCode : 500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/longwrite/init", async (req, reply) => {
    const body = (req.body ?? {}) as Parameters<typeof initArgs>[0];
    try {
      const { targetDir, componentDir, args } = initArgs(body);
      const result = await runMaliang(args, path.dirname(targetDir));
      return { ok: true, dir: targetDir, componentDir, ...result };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/longwrite/approve", async (req, reply) => {
    const { dir, approvalId, batch } = (req.body ?? {}) as { dir?: string; approvalId?: string; batch?: boolean };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    try {
      const state = batch ? await host.approveAllFlow(workspaceDir) : await host.approveFlow(workspaceDir, approvalId ?? "");
      return { ok: true, state };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Approval artifacts are the operator's review surface. Restrict reads to
  // files named by a currently pending approval, rather than exposing an
  // arbitrary workspace-file reader (which could disclose .env or credentials).
  app.get("/api/longwrite/approval-artifact", async (req, reply) => {
    const query = req.query as { dir?: string; path?: string };
    const { workspaceDir } = await resolveWritingWorkspace(query.dir);
    const requested = query.path;
    if (typeof requested !== "string" || requested.length === 0 || path.isAbsolute(requested) || requested.includes("\0")) {
      return reply.status(400).send({ error: "path must be a non-empty workspace-relative approval artifact" });
    }
    const resolved = path.resolve(workspaceDir, requested);
    const relative = path.relative(workspaceDir, resolved);
    if (relative.length === 0 || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return reply.status(400).send({ error: "artifact path escapes the workspace" });
    }
    const flow = asRecord(await host.loadFlowState(workspaceDir));
    const allowed = new Set(
      (Array.isArray(flow.pendingApprovals) ? flow.pendingApprovals : [])
        .map(asRecord)
        .flatMap((approval) => asStringArray(approval.artifacts)),
    );
    if (!allowed.has(requested)) {
      return reply.status(404).send({ error: "artifact is not attached to a pending approval" });
    }
    try {
      const content = await fs.readFile(resolved, "utf-8");
      return {
        path: requested,
        content: content.slice(0, MAX_APPROVAL_ARTIFACT_BYTES),
        truncated: Buffer.byteLength(content, "utf-8") > MAX_APPROVAL_ARTIFACT_BYTES,
      };
    } catch {
      return reply.status(404).send({ error: `approval artifact not found: ${requested}` });
    }
  });

  // Current-manuscript previews use a small explicit allowlist rather than a
  // generic workspace reader. This lets an operator inspect live work without
  // exposing credentials, arbitrary notes, or .malaclaw state files.
  app.get("/api/longwrite/current-artifact", async (req, reply) => {
    const query = req.query as { dir?: string; path?: string };
    const { workspaceDir } = await resolveWritingWorkspace(query.dir);
    const requested = query.path;
    if (typeof requested !== "string" || !isCurrentArtifactPath(requested)) {
      return reply.status(400).send({ error: "path is not an approved current-manuscript artifact" });
    }
    const resolved = path.resolve(workspaceDir, requested);
    const relative = path.relative(workspaceDir, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return reply.status(400).send({ error: "artifact path escapes the workspace" });
    }
    try {
      if (requested.endsWith(".pdf")) {
        return reply.type("application/pdf").send(await fs.readFile(resolved));
      }
      const content = await fs.readFile(resolved, "utf-8");
      return {
        path: requested,
        content: content.slice(0, MAX_CURRENT_ARTIFACT_BYTES),
        truncated: Buffer.byteLength(content, "utf-8") > MAX_CURRENT_ARTIFACT_BYTES,
      };
    } catch {
      return reply.status(404).send({ error: `current artifact not found: ${requested}` });
    }
  });

  app.post("/api/longwrite/packet", async (req, reply) => {
    const { dir } = (req.body ?? {}) as { dir?: string };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    try {
      const result = await runLongWrite(["report", "packet", workspaceDir], workspaceDir);
      return { ok: true, ...result, artifact: "reports/human-review-packet.md" };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/longwrite/feedback", async (req, reply) => {
    const { dir, message } = (req.body ?? {}) as { dir?: string; message?: string };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.status(400).send({ error: "message must be a non-empty string" });
    }
    try {
      const result = await runLongWrite(["feedback", "add", workspaceDir, "--message", message], workspaceDir);
      return { ok: true, artifact: "feedback/user-feedback.md", ...result };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/longwrite/outline/revise", async (req, reply) => {
    const { dir, message } = (req.body ?? {}) as { dir?: string; message?: string };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.status(400).send({ error: "message must be a non-empty string" });
    }
    const flow = asRecord(await host.loadFlowState(workspaceDir));
    const outlineAwaitingApproval = (Array.isArray(flow.pendingApprovals) ? flow.pendingApprovals : [])
      .map(asRecord)
      .some((approval) => asString(approval.stageId) === "outline");
    if (!outlineAwaitingApproval) {
      return reply.status(409).send({ error: "outline revision is available only while the outline approval is pending" });
    }
    try {
      const result = await runLongWrite(["outline", "revise", workspaceDir, "--message", message.trim()], workspaceDir);
      return { ok: true, artifact: "feedback/outline-revision.md", ...result };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/longwrite/run", async (req, reply) => {
    const { dir, runtime, reset } = (req.body ?? {}) as { dir?: string; runtime?: string; reset?: boolean };
    const { workspaceDir, parentWorkspace } = await resolveWritingWorkspace(dir);
    if (runtime !== undefined && (typeof runtime !== "string" || runtime.trim().length === 0)) {
      return reply.status(400).send({ error: "runtime must be a non-empty string" });
    }
    try {
      const record = spawnLongWriteRun(workspaceDir, parentWorkspace, { runtime: runtime?.trim(), reset: reset === true });
      return { ok: true, operation: record };
    } catch (err) {
      const statusCode = typeof err === "object" && err !== null && "statusCode" in err
        ? Number((err as { statusCode?: number }).statusCode)
        : 500;
      return reply.status(Number.isFinite(statusCode) ? statusCode : 500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/longwrite/retry", async (req, reply) => {
    const { dir } = (req.body ?? {}) as { dir?: string };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    try {
      const result = await runLongWrite(["retry", workspaceDir], workspaceDir);
      return { ok: true, ...result };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/longwrite/roles", async (req, reply) => {
    const { workspaceDir } = await resolveWritingWorkspace((req.query as { dir?: string }).dir);
    const rolesDir = path.join(workspaceDir, "roles");
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(rolesDir)).filter((e) => e.endsWith(".md")).sort();
    } catch {
      entries = [];
    }
    const roles = [];
    for (const entry of entries) {
      roles.push({
        owner: entry.replace(/\.md$/, ""),
        content: await fs.readFile(path.join(rolesDir, entry), "utf-8"),
      });
    }
    return { roles };
  });

  app.post("/api/longwrite/roles", async (req, reply) => {
    const { dir, owner, content } = (req.body ?? {}) as { dir?: string; owner?: string; content?: string };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    if (!owner || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) {
      return reply.status(400).send({ error: "owner must be a safe slug" });
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return reply.status(400).send({ error: "role content must be non-empty (delete the file on disk to remove a persona)" });
    }
    const rolesDir = path.join(workspaceDir, "roles");
    await fs.mkdir(rolesDir, { recursive: true });
    await fs.writeFile(path.join(rolesDir, `${owner}.md`), content, "utf-8");
    return { ok: true, owner };
  });

  app.post("/api/longwrite/config", async (req, reply) => {
    const { dir, config } = (req.body ?? {}) as { dir?: string; config?: ProjectConfig };
    const { workspaceDir } = await resolveWritingWorkspace(dir);
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return reply.status(400).send({ error: "config must be an object" });
    }
    try {
      const current = await readYamlIfExists(path.join(workspaceDir, "longwrite.yaml"));
      let flow: unknown = null;
      try { flow = await host.loadFlowState(workspaceDir); } catch { /* no state means the evidence program is still editable */ }
      if (current && hasStartedFlow(flow) && evidenceProgramFingerprint(current) !== evidenceProgramFingerprint(config)) {
        return reply.status(409).send({
          error: "topic, repository inputs, and reference links are locked after source work begins; create a fresh workspace for a new evidence program",
        });
      }
      await validateProjectConfig(config);
      const target = path.join(workspaceDir, "longwrite.yaml");
      await fs.writeFile(target, stringifyYaml(config), "utf-8");
      const result = await runLongWrite(["sync", workspaceDir], workspaceDir);
      return { ok: true, path: "longwrite.yaml", synced: ["project_brief.md", "malaclaw.yaml"], ...result };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // After HAND-EDITS to longwrite.yaml: regenerate the compiled files.
  app.post("/api/longwrite/sync", async (req, reply) => {
    const { workspaceDir } = await resolveWritingWorkspace(((req.body ?? {}) as { dir?: string }).dir);
    try {
      const result = await runLongWrite(["sync", workspaceDir], workspaceDir);
      return { ok: true, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // After HAND-EDITS to malaclaw.yaml: check both config layers without
  // running anything. malaclaw validate is best-effort (needs the CLI on
  // PATH or MALACLAW_BIN).
  app.post("/api/longwrite/validate", async (req, reply) => {
    const { workspaceDir } = await resolveWritingWorkspace(((req.body ?? {}) as { dir?: string }).dir);
    const findings: string[] = [];
    let ok = true;
    try {
      await runLongWrite(["validate", "config", workspaceDir], workspaceDir);
      findings.push("longwrite.yaml: valid");
    } catch (err) {
      ok = false;
      findings.push(`longwrite.yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
    const malaclawBin = process.env.LONGWRITE_MALACLAW_BIN ?? "malaclaw";
    try {
      await new Promise<void>((resolve, rejectPromise) => {
        const child = spawn(malaclawBin, ["validate"], { cwd: workspaceDir, shell: false });
        let output = "";
        child.stdout.on("data", (c: Buffer) => { output += c.toString(); });
        child.stderr.on("data", (c: Buffer) => { output += c.toString(); });
        child.on("error", (err) => rejectPromise(err));
        child.on("close", (code) => {
          if (code === 0) { findings.push("malaclaw.yaml: valid"); resolve(); }
          else rejectPromise(new Error(output.trim().split("\n").slice(-6).join("\n")));
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        findings.push("malaclaw.yaml: not checked (malaclaw CLI not on PATH; set LONGWRITE_MALACLAW_BIN)");
      } else {
        ok = false;
        findings.push(`malaclaw.yaml: ${message}`);
      }
    }
    return { ok, findings };
  });

  app.post("/api/longwrite/workflow/stage", async (req, reply) => {
    const body = (req.body ?? {}) as StagePatch;
    const { workspaceDir } = await resolveWritingWorkspace(body.dir);
    if (typeof body.stageId !== "string" || body.stageId.trim().length === 0) {
      return reply.status(400).send({ error: "stageId must be a non-empty string" });
    }
    if (body.maxParallel !== undefined && body.maxParallel !== null && (!Number.isInteger(body.maxParallel) || body.maxParallel < 1)) {
      return reply.status(400).send({ error: "maxParallel must be a positive integer" });
    }
    const manifestPath = path.join(workspaceDir, "malaclaw.yaml");
    const manifest = await readYamlIfExists(manifestPath);
    if (!manifest) return reply.status(404).send({ error: "malaclaw.yaml not found" });
    try {
      // Validate the target against the generated graph before persisting its
      // durable representation in longwrite.yaml.
      updateManifestStage(manifest, body);
      const configPath = path.join(workspaceDir, "longwrite.yaml");
      const config = await readYamlIfExists(configPath);
      if (!config) return reply.status(404).send({ error: "longwrite.yaml not found" });
      const execution = asRecord(config.execution);
      const stageOverrides = asRecord(execution.stage_overrides);
      const override: YamlRecord = {};
      if (body.runtime?.trim()) override.runtime = body.runtime.trim();
      if (body.model?.trim()) override.model = body.model.trim();
      if (body.modelTier?.trim()) override.model_tier = body.modelTier.trim();
      if (body.requiresHumanApproval !== undefined) override.requires_human_approval = body.requiresHumanApproval;
      if (body.enabled !== undefined) override.enabled = body.enabled;
      if (body.maxParallel !== undefined && body.maxParallel !== null) override.max_parallel = body.maxParallel;
      if (Object.keys(override).length === 0) delete stageOverrides[body.stageId];
      else stageOverrides[body.stageId] = override;
      config.execution = { ...execution, stage_overrides: stageOverrides };
      await validateProjectConfig(config);
      await fs.writeFile(configPath, stringifyYaml(config), "utf-8");
      const result = await runLongWrite(["sync", workspaceDir], workspaceDir);
      return { ok: true, path: "longwrite.yaml", warning: "Durable override saved and malaclaw.yaml regenerated.", ...result };
    } catch (err) {
      const statusCode = typeof err === "object" && err !== null && "statusCode" in err
        ? Number((err as { statusCode?: number }).statusCode)
        : 400;
      return reply.status(Number.isFinite(statusCode) ? statusCode : 400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  };
}
