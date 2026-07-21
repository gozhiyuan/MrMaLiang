import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadProjectConfig } from "../project-config.js";
import { paperProfile } from "../paper-profiles.js";
import { canonicalRepositorySource, type CodebaseConfig } from "./codebase-contract.js";
import { loadSearchPlan, plannedQueries } from "./search-plan.js";

const CANDIDATES_PATH = "codebases/github-candidates.json";
const SELECTION_PATH = "codebases/github-selection.json";
const MAX_README_CHARS = 6_000;
const MAX_GITHUB_SEARCH_QUERY_CHARS = 256;
const MIN_REQUEST_INTERVAL_MS = 250;
const MAX_RETRIES = 2;

const Candidate = z.object({
  id: z.string().regex(/^github-\d+$/),
  github_id: z.number().int().positive(),
  full_name: z.string().min(1),
  html_url: z.string().url(),
  clone_url: z.string().url(),
  default_branch: z.string().min(1),
  description: z.string(),
  topics: z.array(z.string()),
  language: z.string().nullable(),
  license_spdx_id: z.string().nullable(),
  archived: z.boolean(),
  fork: z.boolean(),
  stargazers_count: z.number().int().nonnegative(),
  updated_at: z.string().nullable(),
  query_indices: z.array(z.number().int().nonnegative()).min(1),
  readme_excerpt: z.string().nullable(),
  readme_status: z.enum(["fetched", "unavailable", "not_requested"]),
}).strict();

export const GithubCodebaseCandidates = z.object({
  version: z.literal(1),
  provider: z.literal("github"),
  queries: z.array(z.string()),
  token_authenticated: z.boolean(),
  candidates: z.array(Candidate),
}).strict();

export const GithubCodebaseSelection = z.object({
  version: z.literal(1),
  selections: z.array(z.object({
    candidate_id: z.string().regex(/^github-\d+$/),
    role: z.enum(["primary_artifact", "supplementary_artifact"]),
    rationale: z.string().min(20).max(2_000),
  }).strict()).max(10),
}).strict();

export type DiscoveredCodebase = CodebaseConfig;

type GithubApiRepository = {
  id?: unknown; full_name?: unknown; html_url?: unknown; clone_url?: unknown;
  default_branch?: unknown; description?: unknown; topics?: unknown; language?: unknown;
  license?: { spdx_id?: unknown } | null; archived?: unknown; fork?: unknown;
  stargazers_count?: unknown; updated_at?: unknown;
};

type FetchLike = typeof fetch;

function minimumDiscoverySelections(config: Awaited<ReturnType<typeof loadProjectConfig>>): number {
  return paperProfile(config.research.paper_profile).requiresCodebase && config.research.codebases.length === 0 ? 1 : 0;
}

function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

function headers(token: string | undefined): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "LongWrite-GitHub-Codebase-Discovery",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function compactQuery(value: string, includeArchived: boolean): string {
  const suffix = ` in:name,description,readme fork:false${includeArchived ? "" : " archived:false"}`;
  const normalized = value.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, Math.max(1, MAX_GITHUB_SEARCH_QUERY_CHARS - suffix.length))}${suffix}`;
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function candidateFromRepository(repo: GithubApiRepository, queryIndex: number) {
  const githubId = typeof repo.id === "number" && Number.isInteger(repo.id) ? repo.id : null;
  const fullName = stringOr(repo.full_name);
  const htmlUrl = stringOr(repo.html_url);
  const cloneUrl = stringOr(repo.clone_url);
  const defaultBranch = stringOr(repo.default_branch, "HEAD");
  if (!githubId || !fullName || !htmlUrl || !cloneUrl) return null;
  return {
    id: `github-${githubId}`,
    github_id: githubId,
    full_name: fullName,
    html_url: htmlUrl,
    clone_url: cloneUrl,
    default_branch: defaultBranch,
    description: stringOr(repo.description),
    topics: Array.isArray(repo.topics) ? repo.topics.filter((topic): topic is string => typeof topic === "string") : [],
    language: typeof repo.language === "string" ? repo.language : null,
    license_spdx_id: typeof repo.license?.spdx_id === "string" ? repo.license.spdx_id : null,
    archived: repo.archived === true,
    fork: repo.fork === true,
    stargazers_count: typeof repo.stargazers_count === "number" && Number.isInteger(repo.stargazers_count) ? Math.max(0, repo.stargazers_count) : 0,
    updated_at: typeof repo.updated_at === "string" ? repo.updated_at : null,
    query_indices: [queryIndex],
    readme_excerpt: null,
    readme_status: "not_requested" as const,
  };
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function retryDelayMs(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(30_000, retryAfter * 1_000);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(30_000, Math.max(0, reset * 1_000 - Date.now()));
  return 1_000;
}

class GithubRequestClient {
  private nextRequestAt = 0;

  constructor(private readonly fetchImpl: FetchLike, private readonly token: string | undefined) {}

  async request(url: string, accept?: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const delay = this.nextRequestAt - Date.now();
      if (delay > 0) await wait(delay);
      this.nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
      const response = await this.fetchImpl(url, {
        headers: { ...headers(this.token), ...(accept ? { Accept: accept } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
      if ((response.status !== 429 && response.status !== 403) || attempt === MAX_RETRIES) return response;
      await wait(retryDelayMs(response));
    }
    throw new Error("GitHub request retry loop exhausted unexpectedly");
  }

  async json(url: string): Promise<unknown> {
    const response = await this.request(url);
    if (response.ok) return response.json();
    const detail = (await response.text()).slice(0, 400).replace(/\s+/g, " ");
    const tokenHint = response.status === 401 || response.status === 403 || response.status === 429
      ? " Set GITHUB_TOKEN (or GH_TOKEN) to raise/authorize the GitHub API rate limit."
      : "";
    throw new Error(`GitHub API ${response.status} for ${url}: ${detail || response.statusText}.${tokenHint}`);
  }
}

async function readmeExcerpt(client: GithubRequestClient, fullName: string): Promise<{ excerpt: string | null; status: "fetched" | "unavailable" }> {
  try {
    const [owner, repository] = fullName.split("/", 2);
    if (!owner || !repository) return { excerpt: null, status: "unavailable" };
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/readme`;
    const response = await client.request(url, "application/vnd.github.raw+json");
    if (!response.ok) return { excerpt: null, status: "unavailable" };
    const text = (await response.text()).replace(/\u0000/g, "").trim();
    return { excerpt: text ? text.slice(0, MAX_README_CHARS) : null, status: "fetched" };
  } catch {
    return { excerpt: null, status: "unavailable" };
  }
}

/** Deterministically recall and filter GitHub repository metadata. README
 * excerpts are a screening aid only; selected repos are later Git-pinned and
 * cited as software, never treated as scholarly literature. */
export async function discoverGithubCodebases(workspaceDir: string, fetchImpl: FetchLike = fetch): Promise<string[]> {
  const config = await loadProjectConfig(workspaceDir);
  const settings = config.research.codebase_discovery;
  if (!settings.enabled) throw new Error("GitHub codebase discovery is disabled; set research.codebase_discovery.enabled: true");
  const loadedPlan = await loadSearchPlan(workspaceDir);
  if (!loadedPlan.present || !loadedPlan.ok) throw new Error("GitHub codebase discovery requires a valid sources/search-plan.json");
  const queries = [...new Set(plannedQueries(loadedPlan.plan)
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((query) => compactQuery(query, settings.include_archived)))]
    .slice(0, settings.query_budget);
  if (queries.length === 0) throw new Error("sources/search-plan.json contains no usable query variants for GitHub codebase discovery");
  const token = githubToken();
  const client = new GithubRequestClient(fetchImpl, token);
  const perQuery = Math.max(1, Math.min(100, Math.ceil(settings.max_candidates / queries.length)));
  const candidates = new Map<string, z.infer<typeof Candidate>>();
  for (const [queryIndex, query] of queries.entries()) {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(perQuery));
    const payload = await client.json(url.toString()) as { items?: GithubApiRepository[] };
    for (const repository of payload.items ?? []) {
      const candidate = candidateFromRepository(repository, queryIndex);
      if (!candidate || candidate.fork || (!settings.include_archived && candidate.archived)) continue;
      if (settings.require_license && !candidate.license_spdx_id) continue;
      if (settings.languages.length > 0 && (!candidate.language || !settings.languages.some((language) => language.localeCompare(candidate.language!, undefined, { sensitivity: "accent" }) === 0))) continue;
      const existing = candidates.get(candidate.id);
      if (existing) existing.query_indices = [...new Set([...existing.query_indices, queryIndex])];
      else if (candidates.size < settings.max_candidates) candidates.set(candidate.id, candidate);
    }
  }
  // Map insertion preserves GitHub's API relevance order within each bounded
  // planner query. Do not re-rank on stars: popularity is not evidence quality.
  const ordered = [...candidates.values()].slice(0, settings.max_candidates);
  for (const candidate of ordered.slice(0, settings.max_readme_fetches)) {
    const readme = await readmeExcerpt(client, candidate.full_name);
    candidate.readme_excerpt = readme.excerpt;
    candidate.readme_status = readme.status;
  }
  const artifact = GithubCodebaseCandidates.parse({ version: 1, provider: "github", queries, token_authenticated: Boolean(token), candidates: ordered });
  await fs.mkdir(path.join(workspaceDir, "codebases"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, CANDIDATES_PATH), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return [CANDIDATES_PATH];
}

export async function repairGithubCodebaseSelection(workspaceDir: string): Promise<string[]> {
  const [config, candidatesRaw, selectionRaw] = await Promise.all([
    loadProjectConfig(workspaceDir),
    fs.readFile(path.join(workspaceDir, CANDIDATES_PATH), "utf8"),
    fs.readFile(path.join(workspaceDir, SELECTION_PATH), "utf8"),
  ]);
  const reportPath = path.join(workspaceDir, "reports", "github-codebase-selection-repair.md");
  try {
    const candidates = GithubCodebaseCandidates.parse(JSON.parse(candidatesRaw));
    const selection = GithubCodebaseSelection.parse(JSON.parse(selectionRaw));
    const known = new Set(candidates.candidates.map((candidate) => candidate.id));
    const configuredSources = new Set(config.research.codebases.map((codebase) => canonicalRepositorySource(codebase.source)));
    const selected = new Set<string>();
    const minimum = minimumDiscoverySelections(config);
    if (selection.selections.length < minimum) {
      throw new Error(`${config.research.paper_profile} requires at least ${minimum} GitHub selection when no explicit codebase is configured; select an eligible candidate or add research.codebases before continuing`);
    }
    if (selection.selections.length > config.research.codebase_discovery.max_selected) throw new Error(`selection has ${selection.selections.length} repositories; configured maximum is ${config.research.codebase_discovery.max_selected}`);
    if (selection.selections.length + config.research.codebases.length > 10) throw new Error("configured and discovered codebases together exceed the hard maximum of 10");
    for (const item of selection.selections) {
      if (!known.has(item.candidate_id)) throw new Error(`selection names a repository outside github-candidates.json: ${item.candidate_id}`);
      const candidate = candidates.candidates.find((entry) => entry.id === item.candidate_id)!;
      if (configuredSources.has(canonicalRepositorySource(candidate.clone_url))) throw new Error(`selection duplicates explicitly configured repository ${candidate.full_name}`);
      if (selected.has(item.candidate_id)) throw new Error(`selection contains duplicate repository: ${item.candidate_id}`);
      selected.add(item.candidate_id);
    }
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# GitHub codebase selection repair", "", "- Status: pass", `- Valid selections: ${selection.selections.length}`, `- Minimum selections required: ${minimum}`, `- Configured explicit inputs: ${config.research.codebases.length}`, "- Selected repositories will be Git-pinned as software evidence; they do not count toward scholarly gates.", ""].join("\n"), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# GitHub codebase selection repair", "", "- Status: failed", `- Detail: ${detail}`, "- Required repair: select only unique candidate_id values from codebases/github-candidates.json, within the configured maximum. A repository-study profile without an explicit codebase must select at least one candidate; if none is suitable, add a pinned research.codebases entry or change the paper profile before resuming.", ""].join("\n"), "utf8");
    throw new Error(`codebases/github-selection.json: invalid GitHub codebase-selection contract: ${detail}; see reports/github-codebase-selection-repair.md`);
  }
  return ["reports/github-codebase-selection-repair.md"];
}

export async function selectedGithubCodebases(workspaceDir: string): Promise<DiscoveredCodebase[]> {
  const config = await loadProjectConfig(workspaceDir);
  if (!config.research.codebase_discovery.enabled) return [];
  const [candidatesRaw, selectionRaw] = await Promise.all([
    fs.readFile(path.join(workspaceDir, CANDIDATES_PATH), "utf8"),
    fs.readFile(path.join(workspaceDir, SELECTION_PATH), "utf8"),
  ]);
  const candidates = GithubCodebaseCandidates.parse(JSON.parse(candidatesRaw));
  const selection = GithubCodebaseSelection.parse(JSON.parse(selectionRaw));
  const byId = new Map(candidates.candidates.map((candidate) => [candidate.id, candidate]));
  return selection.selections.map((item) => {
    const candidate = byId.get(item.candidate_id);
    if (!candidate) throw new Error(`GitHub codebase selection references unknown candidate ${item.candidate_id}; run repair first`);
    return { id: candidate.id, source: candidate.clone_url, ref: candidate.default_branch, title: candidate.full_name, role: item.role };
  });
}
