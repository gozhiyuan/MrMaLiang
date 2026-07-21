import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** One grammar for pinned-repository citations across drafting, validation,
 * and LaTeX rendering.  Keep this separate from scholarly `[source:...]`
 * markers: codebases are software evidence, not literature records. */
export const CODEBASE_MARKER_RE = /\[codebase:([a-z][a-z0-9_-]*)(?::[^\]\s]+)?\]/g;

export function codebaseMarkerIds(markdown: string): string[] {
  return [...markdown.matchAll(new RegExp(CODEBASE_MARKER_RE.source, "g"))].map((match) => match[1]!);
}

/** Canonical identity used to prevent the same remote repository entering as
 * both an explicit and discovered source under different internal IDs. */
export function canonicalRepositorySource(source: string): string {
  const trimmed = source.trim().replace(/\/$/, "");
  const scp = trimmed.match(/^git@([^:]+):(.+)$/i);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase()}`;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = decodeURIComponent(url.pathname).replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
    return `${host}/${pathname}`;
  } catch {
    return `local:${path.resolve(trimmed)}`;
  }
}

/** Preserve simple legacy keys while encoding every non-alphanumeric byte.
 * Escaping underscores too makes the mapping injective for valid codebase ids:
 * `repo-a`, `repo_a`, and `repo_2d_a` cannot collide. */
export function codebaseBibtexKey(id: string): string {
  return `codebase${[...id].map((char) => /[A-Za-z0-9]/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`).join("")}`;
}

export const CodebaseInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "must be a lowercase slug"),
  source: z.string().min(1).max(2_000),
  ref: z.string().min(1).max(200).default("HEAD"),
  title: z.string().min(1).max(300).optional(),
  role: z.enum(["primary_artifact", "supplementary_artifact"]).default("primary_artifact"),
}).strict();

export const DEFAULT_GITHUB_CODEBASE_DISCOVERY = {
  enabled: false,
  provider: "github" as const,
  query_budget: 10,
  max_candidates: 40,
  max_readme_fetches: 12,
  max_selected: 8,
  require_license: true,
  include_archived: false,
  languages: [] as string[],
};

export const GithubCodebaseDiscovery = z.object({
  enabled: z.boolean().default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.enabled),
  provider: z.literal("github").default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.provider),
  query_budget: z.number().int().min(1).max(20).default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.query_budget),
  max_candidates: z.number().int().min(1).max(100).default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.max_candidates),
  max_readme_fetches: z.number().int().min(0).max(40).default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.max_readme_fetches),
  max_selected: z.number().int().min(1).max(10).default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.max_selected),
  require_license: z.boolean().default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.require_license),
  include_archived: z.boolean().default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.include_archived),
  languages: z.array(z.string().min(1).max(80)).max(20).default(DEFAULT_GITHUB_CODEBASE_DISCOVERY.languages),
}).strict().default(DEFAULT_GITHUB_CODEBASE_DISCOVERY);

export const CodebaseManifestRecord = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  source: z.string().min(1),
  requested_ref: z.string().min(1),
  resolved_commit: z.string().regex(/^[0-9a-f]{40}$/i),
  title: z.string().min(1),
  role: z.enum(["primary_artifact", "supplementary_artifact"]),
  snapshot_path: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative() }).strict()),
  generated_at: z.string().datetime(),
  commit_date: z.string().datetime().optional(),
  citation_metadata: z.object({
    source: z.enum(["CITATION.cff", "git"]),
    authors: z.array(z.string().min(1)).default([]),
    version: z.string().min(1).optional(),
    date: z.string().min(4).optional(),
    doi: z.string().min(3).optional(),
    url: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

export const CodebaseManifestIndex = z.object({
  version: z.literal(1),
  codebases: z.array(CodebaseManifestRecord).max(10),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const record of value.codebases) {
    if (ids.has(record.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate codebase id ${record.id}` });
    ids.add(record.id);
  }
});

export type CodebaseConfig = z.infer<typeof CodebaseInput>;
export type GithubCodebaseDiscoveryConfig = z.infer<typeof GithubCodebaseDiscovery>;
export type CodebaseManifest = z.infer<typeof CodebaseManifestRecord>;
export type CodebaseManifestIndex = z.infer<typeof CodebaseManifestIndex>;

export async function loadCodebaseManifest(workspaceDir: string): Promise<CodebaseManifestIndex | null> {
  const manifestPath = path.join(workspaceDir, "codebases", "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return CodebaseManifestIndex.parse(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`codebases/manifest.json is not valid pinned codebase metadata: ${detail}`);
  }
}
