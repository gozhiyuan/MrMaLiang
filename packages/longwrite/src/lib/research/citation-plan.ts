import fs from "node:fs/promises";
import path from "node:path";
import type { CitationPlanEntry, ClassifiedSource } from "./types.js";

/** One citation-plan entry per REAL outline section.
 *
 * The previous implementation emitted two entries — "Background and Motivation"
 * and "Workflow Architecture and Evaluation" — for any outline, any topic, and
 * at most six sources. Every section beyond the second matched no entry, and
 * the drafter's `?? citationPlan[0]` handed all of them section one's sources.
 * The manuscript that produces is the failure mode this whole programme is
 * about: many sections, one narrow source set, prose that walks through the
 * same handful of papers one at a time.
 *
 * Allocation is by the section's own contract — the sources it names, the
 * keywords it declares, and the depth the corpus recorded — never by position
 * in a list. */

/** A section as the outline declares it. `source_ids` is an explicit editorial
 * allocation and outranks everything else: an outline that already says which
 * sources a section rests on has made a decision this function must not
 * overrule. */
export type PlannedSection = {
  id: string;
  title?: string;
  keywords?: string[];
  sourceIds?: string[];
};

/** How many sources a section is planned to cite before the drafter looks at
 * its evidence packet. Enough to argue with; few enough that a section is not
 * a survey of the whole corpus. */
const PER_SECTION = { min: 2, max: 6 } as const;
/** Below this lexical overlap, affinity is a tie-breaker rather than evidence
 * that a source belongs in the section.  This lets the coverage pass use an
 * uncited but plausible source before repeatedly selecting a familiar title. */
const RELEVANCE_FLOOR = 0.15;

const DEPTH_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3);
}

/** How well a source answers to a section's declared contract.
 *
 * Deliberately lexical and deliberately explained: this is a PLAN, refined
 * later by real evidence allocation against the full-text index. Its job is to
 * give every section a distinct, defensible starting set rather than to be the
 * final word on relevance. */
function affinity(section: PlannedSection, source: ClassifiedSource): number {
  const terms = new Set([
    ...tokens(section.title ?? section.id),
    ...(section.keywords ?? []).flatMap(tokens),
  ]);
  if (terms.size === 0) return 0;
  const haystack = new Set([...tokens(source.title ?? ""), ...tokens(source.venue ?? "")]);
  let hits = 0;
  for (const term of terms) if (haystack.has(term)) hits += 1;
  return hits / terms.size;
}

export function buildCitationPlan(
  sources: ClassifiedSource[], sections: PlannedSection[],
): CitationPlanEntry[] {
  if (sections.length === 0) {
    throw new Error(
      "a citation plan needs the outline's sections; building one from the corpus alone " +
      "produces generic entries no real section matches");
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  // Depth first, then quality: an A-depth source is one the corpus already
  // decided carries weight, and a plan that ignored that would spread the
  // manuscript's citations across whatever happened to rank highly lexically.
  const ranked = [...sources].sort((a, b) =>
    (DEPTH_RANK[a.citation_depth] ?? 9) - (DEPTH_RANK[b.citation_depth] ?? 9)
    || (b.quality_score ?? 0) - (a.quality_score ?? 0)
    || a.id.localeCompare(b.id));

  // Every source should reach at least one section before any source reaches a
  // second: a corpus of forty papers cited across six sections by way of the
  // same six papers is the shape this counter exists to prevent.
  const used = new Map<string, number>();
  const entries: CitationPlanEntry[] = [];
  for (const section of sections) {
    const declared = (section.sourceIds ?? []).filter((id) => byId.has(id));
    const scored = ranked
      .filter((source) => !declared.includes(source.id))
      .map((source) => ({ source, score: affinity(section, source) }))
      .sort((a, b) => {
        // Coverage is a first-class allocation pass.  Among sources that are
        // actually relevant to this section, use an unseen source before a
        // repeated one; affinity then picks the best of that coverage tier.
        // Once every relevant candidate has appeared, ordinary relevance
        // ranking resumes.  The former sort put affinity first, so a recurring
        // section vocabulary repeatedly consumed the same six sources.
        const aRelevant = a.score >= RELEVANCE_FLOOR;
        const bRelevant = b.score >= RELEVANCE_FLOOR;
        const aUsage = used.get(a.source.id) ?? 0;
        const bUsage = used.get(b.source.id) ?? 0;
        if (aRelevant && bRelevant && aUsage !== bUsage) return aUsage - bUsage;
        if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;
        return b.score - a.score
        || aUsage - bUsage
        || (DEPTH_RANK[a.source.citation_depth] ?? 9) - (DEPTH_RANK[b.source.citation_depth] ?? 9)
        || a.source.id.localeCompare(b.source.id);
      });

    const chosen = [...declared];
    for (const { source } of scored) {
      if (chosen.length >= PER_SECTION.max) break;
      chosen.push(source.id);
    }
    for (const id of chosen) used.set(id, (used.get(id) ?? 0) + 1);
    entries.push({
      section_id: section.id,
      section_title: section.title ?? section.id,
      source_ids: chosen,
    });
  }

  // A section with nothing to cite is a section that cannot be written to the
  // manuscript's own standard, and discovering that at drafting time — one
  // section at a time, after the budget is spent — is far worse than saying so
  // now.
  const starved = entries.filter((entry) => entry.source_ids.length < PER_SECTION.min);
  if (starved.length > 0 && sources.length >= PER_SECTION.min) {
    throw new Error(
      `sections ${starved.map((entry) => entry.section_id).join(", ")} could be allocated fewer ` +
      `than ${PER_SECTION.min} sources from a corpus of ${sources.length}; expand the corpus or ` +
      `reduce the outline before drafting`);
  }
  return entries;
}

/** The outline's sections, for callers that plan from the workspace.
 *
 * Absent outline is an error, not an empty list: a plan built from no sections
 * is exactly the generic two-entry plan this module replaced. */
export async function plannedSections(workspaceDir: string): Promise<PlannedSection[]> {
  const raw = await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8").catch(() => null);
  if (raw === null) {
    throw new Error("outline.json is required before a citation plan can name real sections");
  }
  const parsed = JSON.parse(raw) as { sections?: unknown };
  if (!Array.isArray(parsed.sections)) {
    throw new Error("outline.json must contain a sections array before a citation plan can be built");
  }
  const sections = parsed.sections
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => ({
      id: typeof value.id === "string" ? value.id : "",
      title: typeof value.title === "string" ? value.title : undefined,
      keywords: Array.isArray(value.keywords)
        ? value.keywords.filter((term): term is string => typeof term === "string") : [],
      sourceIds: Array.isArray(value.source_ids)
        ? value.source_ids.filter((id): id is string => typeof id === "string") : [],
    }))
    .filter((section) => section.id.length > 0);
  if (sections.length === 0) throw new Error("outline.json sections must carry string ids");
  return sections;
}
