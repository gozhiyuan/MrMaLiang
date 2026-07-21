import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { loadProjectConfig } from "../project-config.js";
import { paperProfile } from "../paper-profiles.js";
import { selectedGithubCodebases } from "./github-codebase-discovery.js";
import { CodebaseManifestIndex, canonicalRepositorySource, codebaseBibtexKey, loadCodebaseManifest, type CodebaseConfig, type CodebaseManifest } from "./codebase-contract.js";
import { CodebaseAnalysisPacket, CODEBASE_ANALYSIS_RAW_PATH } from "./codebase-analysis.js";
import { CodebaseComparisonPacket, CODEBASE_COMPARISON_RAW_PATH } from "./codebase-comparison.js";

const execFile = promisify(execFileCallback);
const MAX_FILES_PER_CODEBASE = 120;
const MAX_FILE_BYTES = 128_000;
const MAX_CONTEXT_CHARS = 120_000;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".sh", ".sql", ".html", ".css"]);
const ALWAYS_INCLUDE = new Set(["README", "README.md", "README.mdx", "CITATION.cff", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "LICENSE"]);
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "vendor"]);
const MAX_MENTIONED_REPOSITORIES = 40;

function filePriority(rel: string): number {
  const name = path.basename(rel);
  if (ALWAYS_INCLUDE.has(name)) return 0;
  if (/(^|\/)(?:index|main|cli|app|server|runner)\.[A-Za-z0-9]+$/i.test(rel)) return 1;
  if (/(^|\/)(?:src|lib|app|packages)\//i.test(rel)) return 2;
  if (/(?:test|spec|fixture|example)/i.test(rel)) return 4;
  return 3;
}

function escapeBibtex(value: string): string {
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFile("git", args, { cwd, encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`Git codebase preparation failed (${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function isLocalSource(source: string): boolean {
  return !/^(https?:\/\/|git@|ssh:\/\/)/i.test(source);
}

async function selectedFiles(root: string, rel = ""): Promise<string[]> {
  const dir = path.join(root, rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(rel, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) result.push(...await selectedFiles(root, child));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ALWAYS_INCLUDE.has(entry.name) || TEXT_EXTENSIONS.has(ext)) result.push(child);
    if (result.length >= MAX_FILES_PER_CODEBASE) break;
  }
  return result.sort((a, b) => filePriority(a) - filePriority(b) || a.localeCompare(b)).slice(0, MAX_FILES_PER_CODEBASE);
}

function cffAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    const literal = typeof record.name === "string" ? record.name.trim() : "";
    const family = typeof record["family-names"] === "string" ? record["family-names"].trim() : "";
    const given = typeof record["given-names"] === "string" ? record["given-names"].trim() : "";
    const name = literal || [family, given].filter(Boolean).join(", ");
    return name ? [name] : [];
  });
}

async function citationMetadata(snapshot: string, codebase: CodebaseConfig, commitDate: string): Promise<NonNullable<CodebaseManifest["citation_metadata"]>> {
  try {
    const parsed = parseYaml(await fs.readFile(path.join(snapshot, "CITATION.cff"), "utf8")) as Record<string, unknown>;
    const string = (key: string) => typeof parsed[key] === "string" && parsed[key].trim() ? parsed[key].trim() : undefined;
    return {
      source: "CITATION.cff",
      authors: cffAuthors(parsed.authors),
      ...(string("version") ? { version: string("version") } : {}),
      ...(string("date-released") ? { date: string("date-released") } : {}),
      ...(string("doi") ? { doi: string("doi")!.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") } : {}),
      ...((string("url") ?? string("repository-code")) ? { url: string("url") ?? string("repository-code") } : {}),
    };
  } catch {
    return { source: "git", authors: [], version: codebase.ref === "HEAD" ? undefined : codebase.ref, date: commitDate, url: codebase.source };
  }
}

function chunksForFile(id: string, rel: string, text: string): Array<{ id: string; codebase_id: string; path: string; start_line: number; end_line: number; text: string }> {
  const lines = text.split(/\r?\n/);
  const chunks: Array<{ id: string; codebase_id: string; path: string; start_line: number; end_line: number; text: string }> = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && chars + lines[end].length + 1 <= 2_400) { chars += lines[end].length + 1; end += 1; }
    if (end === start) end += 1;
    const body = lines.slice(start, end).join("\n").trim();
    if (body.length >= 40) chunks.push({ id: `codebase:${id}:${rel.replace(/[^A-Za-z0-9._-]/g, "_")}:L${start + 1}-L${end}`, codebase_id: id, path: rel, start_line: start + 1, end_line: end, text: body });
    start = end;
  }
  return chunks;
}

async function prepareOne(workspaceDir: string, codebase: CodebaseConfig): Promise<{ manifest: CodebaseManifest; chunks: Array<{ id: string; codebase_id: string; path: string; start_line: number; end_line: number; text: string }> }> {
  const base = path.join(workspaceDir, "codebases", codebase.id);
  const snapshot = path.join(base, "snapshot");
  const manifestPath = path.join(base, "manifest.json");
  if (await exists(snapshot)) {
    // A rerun deliberately reuses its already resolved snapshot for
    // resumability. Ref/source edits must not silently keep old evidence.
    try {
      const previous = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<CodebaseManifest>;
      if (previous.source !== codebase.source || previous.requested_ref !== codebase.ref) {
        throw new Error(`Codebase ${codebase.id}: configured source/ref differs from its existing pinned snapshot; use a new id for a new evidence record or archive the workspace before replacing it`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`Codebase ${codebase.id}:`)) throw error;
      throw new Error(`Codebase ${codebase.id}: existing snapshot has no readable manifest and cannot be safely reused`);
    }
  } else {
    await fs.mkdir(base, { recursive: true });
    const source = isLocalSource(codebase.source) ? path.resolve(workspaceDir, codebase.source) : codebase.source;
    if (isLocalSource(codebase.source) && !await exists(source)) throw new Error(`Codebase ${codebase.id}: local source does not exist: ${source}`);
    await git(["clone", "--no-checkout", "--depth", "1", source, snapshot]);
    if (codebase.ref !== "HEAD") await git(["fetch", "--depth", "1", "origin", codebase.ref], snapshot);
    await git(["checkout", "--detach", codebase.ref === "HEAD" ? "HEAD" : "FETCH_HEAD"], snapshot);
  }
  const resolvedCommit = await git(["rev-parse", "HEAD"], snapshot);
  const commitDate = new Date(await git(["show", "-s", "--format=%cI", "HEAD"], snapshot)).toISOString();
  const files = await selectedFiles(snapshot);
  const chunks: Array<{ id: string; codebase_id: string; path: string; start_line: number; end_line: number; text: string }> = [];
  const fileManifest: Array<{ path: string; bytes: number }> = [];
  for (const rel of files) {
    const abs = path.join(snapshot, rel);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) continue;
    const buffer = await fs.readFile(abs);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    fileManifest.push({ path: rel, bytes: stat.size });
    chunks.push(...chunksForFile(codebase.id, rel, text));
  }
  const citation = await citationMetadata(snapshot, codebase, commitDate);
  let citationTitle = codebase.title ?? codebase.id;
  try {
    const parsed = parseYaml(await fs.readFile(path.join(snapshot, "CITATION.cff"), "utf8")) as Record<string, unknown>;
    if (typeof parsed.title === "string" && parsed.title.trim()) citationTitle = parsed.title.trim();
  } catch { /* fallback title */ }
  const manifest: CodebaseManifest = { version: 1, id: codebase.id, source: codebase.source, requested_ref: codebase.ref, resolved_commit: resolvedCommit, title: citationTitle, role: codebase.role, snapshot_path: `codebases/${codebase.id}/snapshot`, files: fileManifest, generated_at: new Date().toISOString(), commit_date: commitDate, citation_metadata: citation };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, chunks };
}

export async function prepareCodebases(workspaceDir: string): Promise<{ written: string[]; codebases: number; chunks: number }> {
  const root = path.resolve(workspaceDir);
  const config = await loadProjectConfig(root);
  const discovered = await selectedGithubCodebases(root);
  const inputs = [...config.research.codebases, ...discovered];
  const profile = paperProfile(config.research.paper_profile);
  if (profile.requiresCodebase && inputs.length === 0) {
    throw new Error(`${profile.id} requires at least one configured or GitHub-selected codebase before evidence preparation`);
  }
  if (inputs.length > 10) throw new Error("configured and discovered codebases together exceed the hard maximum of 10");
  const ids = new Set<string>();
  const canonicalSources = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.id)) throw new Error(`duplicate codebase id across configured/discovered inputs: ${input.id}`);
    ids.add(input.id);
    const canonical = canonicalRepositorySource(input.source);
    if (canonicalSources.has(canonical)) throw new Error(`duplicate repository source across configured/discovered inputs: ${input.source}`);
    canonicalSources.add(canonical);
  }
  const prepared = await Promise.all(inputs.map((codebase) => prepareOne(root, codebase)));
  const chunks = prepared.flatMap((item) => item.chunks);
  const manifests = prepared.map((item) => item.manifest);
  const context: string[] = ["# Codebase Evidence Context", "", "Use only the supplied snapshot locators. Cite a repository with `[codebase:<id>]` or `[codebase:<id>:path#Lx-Ly]`; do not treat it as scholarly literature or invent execution results.", ""];
  let chars = context.join("\n").length;
  const byCodebase = new Map(manifests.map((manifest) => [manifest.id, chunks.filter((chunk) => chunk.codebase_id === manifest.id)] as const));
  const balanced: typeof chunks = [];
  for (let offset = 0; ; offset += 1) {
    let added = false;
    for (const manifest of manifests) {
      const chunk = byCodebase.get(manifest.id)?.[offset];
      if (chunk) { balanced.push(chunk); added = true; }
    }
    if (!added) break;
  }
  for (const chunk of balanced) {
    const marker = `[codebase:${chunk.codebase_id}:${chunk.path}#L${chunk.start_line}-L${chunk.end_line}]`;
    const block = `## ${marker}\n\n${chunk.text}\n`;
    if (chars + block.length > MAX_CONTEXT_CHARS) break;
    context.push(block); chars += block.length;
  }
  const bib = manifests.map((manifest) => {
    const citation = manifest.citation_metadata;
    const year = (citation?.date ?? manifest.commit_date ?? manifest.generated_at).slice(0, 4);
    const authors = citation?.authors.length ? citation.authors.map(escapeBibtex).join(" and ") : "{Repository maintainers}";
    return `@software{${codebaseBibtexKey(manifest.id)},\n  title = {${escapeBibtex(manifest.title)}},\n  author = {${authors}},\n  year = {${year}},\n  version = {${escapeBibtex(citation?.version ?? manifest.resolved_commit)}},\n  url = {${escapeBibtex(citation?.url ?? manifest.source)}},${citation?.doi ? `\n  doi = {${escapeBibtex(citation.doi)}},` : ""}\n  note = {Pinned snapshot: ${escapeBibtex(manifest.resolved_commit)}}\n}`;
  }).join("\n\n") + (manifests.length ? "\n" : "");
  for (const manifest of manifests) {
    const citationUrl = manifest.citation_metadata?.url;
    if (citationUrl) canonicalSources.add(canonicalRepositorySource(citationUrl));
  }
  const mentioned = chunks
    .filter((chunk) => /(?:^|\/)(?:README(?:\.md|\.mdx)?|CITATION\.cff)$/i.test(chunk.path))
    .flatMap((chunk) => [...chunk.text.matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi)].map((match) => ({
      source_codebase_id: chunk.codebase_id,
      url: match[0]!.replace(/[),.;]+$/, ""),
      canonical_source: canonicalRepositorySource(match[0]!.replace(/[),.;]+$/, "")),
      locator: `[codebase:${chunk.codebase_id}:${chunk.path}#L${chunk.start_line}-L${chunk.end_line}]`,
    })))
    .filter((item, index, all) => !canonicalSources.has(item.canonical_source) && all.findIndex((candidate) => candidate.canonical_source === item.canonical_source) === index)
    .slice(0, MAX_MENTIONED_REPOSITORIES);
  await Promise.all([
    fs.mkdir(path.join(root, "evidence"), { recursive: true }),
    fs.mkdir(path.join(root, "sources"), { recursive: true }),
    fs.mkdir(path.join(root, "codebases"), { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, "evidence", "codebase-chunks.jsonl"), chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + (chunks.length ? "\n" : ""), "utf8");
  await fs.writeFile(path.join(root, "evidence", "codebase-context.md"), `${context.join("\n")}\n`, "utf8");
  await fs.writeFile(path.join(root, "sources", "codebases.bib"), bib, "utf8");
  await fs.writeFile(path.join(root, "codebases", "mentioned-repositories.json"), `${JSON.stringify({ version: 1, candidates: mentioned, recursive_fetch_performed: false }, null, 2)}\n`, "utf8");
  const index = CodebaseManifestIndex.parse({ version: 1, codebases: manifests });
  await fs.writeFile(path.join(root, "codebases", "manifest.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  // MalaClaw's dry-run worker copies fixture outputs instead of calling an
  // LLM. Build a deliberately content-free but locator-valid packet only for
  // that control-plane rehearsal. Live runtimes ignore .malaclaw/fixtures and
  // must author the real architecture analysis from the pinned evidence.
  const fixtureCodebases = manifests.flatMap((manifest) => {
    const first = chunks.find((chunk) => chunk.codebase_id === manifest.id);
    if (!first) return [];
    const locator = `[codebase:${first.codebase_id}:${first.path}#L${first.start_line}-L${first.end_line}]`;
    return [{
      codebase_id: manifest.id,
      summary: `Dry-run fixture for ${manifest.title}; no architecture or execution conclusion is asserted.`,
      summary_locators: [locator],
      components: [{ id: "dry-run-fixture", name: "Dry-run fixture", summary: "Control-plane placeholder grounded in the first bounded repository chunk.", locators: [locator] }],
      entrypoints: [], interfaces: [], data_control_flows: [], configuration_extension_points: [], trust_boundaries: [], operational_limitations: [],
    }];
  });
  if (fixtureCodebases.length === manifests.length && manifests.length > 0) {
    const fixture = CodebaseAnalysisPacket.parse({ version: 1, codebases: fixtureCodebases });
    const fixturePath = path.join(root, ".malaclaw", "fixtures", CODEBASE_ANALYSIS_RAW_PATH);
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const comparisonRows = fixtureCodebases.map((item) => ({
      codebase_id: item.codebase_id,
      purpose: "Dry-run fixture purpose; no software capability conclusion is asserted.",
      architecture_summary: "Dry-run fixture architecture summary grounded only in one bounded chunk.",
      license: null,
      extension_points: [], limitations: [], locators: item.summary_locators,
    }));
    const comparisons = comparisonRows.length > 1 ? [{
      dimension: "dry-run control-plane comparison",
      codebase_ids: comparisonRows.map((item) => item.codebase_id),
      synthesis: "Dry-run fixture comparison used only to exercise the multi-repository validation contract.",
      locators: comparisonRows.flatMap((item) => item.locators),
    }] : [];
    const comparisonFixture = CodebaseComparisonPacket.parse({ version: 1, codebases: comparisonRows, comparisons });
    const comparisonFixturePath = path.join(root, ".malaclaw", "fixtures", CODEBASE_COMPARISON_RAW_PATH);
    await fs.mkdir(path.dirname(comparisonFixturePath), { recursive: true });
    await fs.writeFile(comparisonFixturePath, `${JSON.stringify(comparisonFixture, null, 2)}\n`, "utf8");
  }
  return { written: ["codebases/manifest.json", ...manifests.map((manifest) => `codebases/${manifest.id}/manifest.json`), "codebases/mentioned-repositories.json", "evidence/codebase-chunks.jsonl", "evidence/codebase-context.md", "sources/codebases.bib"], codebases: manifests.length, chunks: chunks.length };
}

export async function codebaseCitationKeys(workspaceDir: string): Promise<Map<string, string>> {
  const manifest = await loadCodebaseManifest(workspaceDir);
  return new Map((manifest?.codebases ?? []).map((entry) => [entry.id, codebaseBibtexKey(entry.id)] as const));
}
