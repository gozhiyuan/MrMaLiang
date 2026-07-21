import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Optional LLM-authored search plan consumed by deterministic retrieval.
 *  The planner stage (an LLM) writes sources/search-plan.json; recall then
 *  EXECUTES the plan mechanically — query variants against the provider,
 *  exclusion terms filtered post-hoc, venue priorities recorded for the
 *  scorer. Missing plan = topic-only retrieval (unchanged behavior).
 *  Invalid plan = loud error, never a silent fallback. */

export const SearchPlan = z
  .object({
    version: z.literal(1).default(1),
    topic: z.string().min(1),
    /** Executed in order against the provider; capped to keep retrieval bounded. */
    query_variants: z.array(z.string().min(3)).min(1).max(50),
    /** Sources whose title matches any exclusion term are dropped. */
    exclusion_terms: z.array(z.string().min(2)).default([]),
    /** Advisory for scoring/classification, recorded in the tooling report. */
    venue_priorities: z.array(z.string().min(1)).default([]),
    source_types: z.array(z.enum(["paper", "preprint", "survey", "benchmark", "blog"])).default([]),
    taxonomy_cells: z.array(z.object({
      cell: z.string().min(2),
      query_variants: z.array(z.string().min(3)).min(3).max(12),
    }).strict()).default([]),
    rationale: z.string().optional(),
  })
  .strict();

export type SearchPlan = z.infer<typeof SearchPlan>;

function taxonomyTokens(value: string): string[] {
  const ignored = new Set(["and", "the", "for", "with", "from", "into", "long"]);
  return [...new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map((token) => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token)
    .filter((token) => !ignored.has(token)))];
}

/**
 * Match a configured coverage label to its LLM-authored query group without
 * requiring exact punctuation/capitalization. The planner is still instructed
 * to preserve labels verbatim; this also accepts harmless expansions such as
 * "memory architectures and lifecycle" in pre-existing workspaces.
 */
export function matchingTaxonomyCell(cell: string, plan: SearchPlan): SearchPlan["taxonomy_cells"][number] | undefined {
  const target = taxonomyTokens(cell);
  if (target.length === 0) return undefined;
  const normalized = cell.trim().toLowerCase();
  const ranked = plan.taxonomy_cells.map((candidate) => {
    const candidateText = candidate.cell.trim().toLowerCase();
    if (candidateText === normalized) return { candidate, overlap: target.length };
    const candidateTokens = new Set(taxonomyTokens(candidate.cell));
    return { candidate, overlap: target.filter((token) => candidateTokens.has(token)).length };
  }).sort((a, b) => b.overlap - a.overlap);
  const best = ranked[0];
  const minimumOverlap = target.length === 1 ? 1 : 2;
  return best && best.overlap >= minimumOverlap ? best.candidate : undefined;
}

export const SEARCH_PLAN_PATH = "sources/search-plan.json";

export type SearchPlanLoad =
  | { present: false }
  | { present: true; ok: true; plan: SearchPlan }
  | { present: true; ok: false; findings: string[] };

export async function loadSearchPlan(workspaceDir: string): Promise<SearchPlanLoad> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspaceDir, SEARCH_PLAN_PATH), "utf-8");
  } catch {
    return { present: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { present: true, ok: false, findings: [`${SEARCH_PLAN_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = SearchPlan.safeParse(parsed);
  if (!result.success) {
    return {
      present: true,
      ok: false,
      findings: result.error.issues.map((i) => `${SEARCH_PLAN_PATH}: ${i.path.join(".")} — ${i.message}`),
    };
  }
  return { present: true, ok: true, plan: result.data };
}

export function plannedQueries(plan: SearchPlan): string[] {
  return [
    ...plan.query_variants,
    ...plan.taxonomy_cells.flatMap((cell) => cell.query_variants),
  ].filter((query, index, all) => all.indexOf(query) === index);
}

export function applyExclusions<T extends { title: string; abstract: string }>(
  sources: T[],
  exclusionTerms: string[],
): { kept: T[]; dropped: number } {
  if (exclusionTerms.length === 0) return { kept: sources, dropped: 0 };
  const terms = exclusionTerms.map((t) => t.toLowerCase());
  const kept = sources.filter((s) => {
    const haystack = `${s.title} ${s.abstract}`.toLowerCase();
    return !terms.some((term) => haystack.includes(term));
  });
  return { kept, dropped: sources.length - kept.length };
}
