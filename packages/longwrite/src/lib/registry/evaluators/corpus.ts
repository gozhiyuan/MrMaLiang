import fs from "node:fs/promises";
import path from "node:path";
import {
  chapterFiles, citedSourceIds, isAcceptedSource, isArxivOnlySource, isWithinOneCalendarYear,
} from "../../validation/research.js";
import { loadProjectConfigIfExists } from "../../project-config.js";
import { isRecentSource, sourceTypeDiversity, taxonomyCellCounts } from "../../research/corpus-gates.js";
import type { ClassifiedSource } from "../../research/types.js";
import { GLOBAL_SCOPE, scopeKey } from "../scope.js";

export type EvaluatorContext = { workspaceDir: string; asOfDate: string };
export type ScopedValue = { scope_key: string; value: number };
/** Returns an ARRAY of scoped values, so a scoped metric cannot accidentally
 * aggregate: reporting one number for a per-cell metric is not expressible. */
export type EvaluatorFn = (ctx: EvaluatorContext) => Promise<ScopedValue[]>;

/** A required input was absent, so no honest number exists. Distinct from
 * measuring zero, which is a claim about the corpus rather than about our
 * ability to look at it. */
export class MeasurementUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MeasurementUnavailable";
  }
}

const global = (value: number): ScopedValue[] => [{ scope_key: GLOBAL_SCOPE, value }];

/** Zero rather than NaN on an empty denominator: a ratio over nothing is
 * reported as unmet, never as a value the kernel cannot compare. */
const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

const CORPUS = path.join("sources", "classified_sources.jsonl");

/** Strict where the validator's loader is forgiving. The validator turns a
 * parse error into a finding and carries on with the rows it got; a
 * measurement must not, because a silently dropped row is a wrong number
 * reported with full confidence. */
async function loadSources(workspaceDir: string): Promise<ClassifiedSource[]> {
  const raw = await fs.readFile(path.join(workspaceDir, CORPUS), "utf-8").catch(() => null);
  if (raw === null) throw new MeasurementUnavailable(`${CORPUS} is missing`);
  const sources: ClassifiedSource[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const text = line.trim();
    if (text === "") continue;
    try {
      sources.push(JSON.parse(text) as ClassifiedSource);
    } catch {
      throw new Error(`malformed source record at ${CORPUS}:${index + 1}`);
    }
  }
  return sources;
}

async function citedSources(ctx: EvaluatorContext): Promise<ClassifiedSource[]> {
  const sources = await loadSources(ctx.workspaceDir);
  const byId = new Map(sources.map((source) => [source.id, source]));
  const cited = citedSourceIds(await chapterFiles(ctx.workspaceDir));
  return [...cited]
    .map((id) => byId.get(id))
    .filter((source): source is ClassifiedSource => Boolean(source));
}

const isCore = (source: ClassifiedSource): boolean =>
  source.citation_depth === "A" || source.citation_depth === "B";

export const CORPUS_EVALUATORS: Record<string, EvaluatorFn> = {
  candidate_count: async (ctx) => global((await loadSources(ctx.workspaceDir)).length),

  core_sources: async (ctx) => global((await loadSources(ctx.workspaceDir)).filter(isCore).length),

  /** Shares isRecentSource with the corpus gate that reads this value. Two
   * recency windows — one here and one in the gate — would let a gate fail
   * while its own observation said it should have passed. */
  recent_source_ratio: async (ctx) => {
    const sources = await loadSources(ctx.workspaceDir);
    return global(ratio(
      sources.filter((source) => isRecentSource(source, ctx.asOfDate)).length, sources.length));
  },

  /** Shares sourceTypeDiversity with the gate that reads this value. Counting
   * providers here while the gate counted providers plus identifier systems
   * gave one workspace two different values for one objective. */
  source_type_diversity_count: async (ctx) =>
    global(sourceTypeDiversity(await loadSources(ctx.workspaceDir))),

  cited_sources: async (ctx) => global((await citedSources(ctx)).length),

  cited_within_one_year_ratio: async (ctx) => {
    const cited = await citedSources(ctx);
    return global(ratio(
      cited.filter((source) => isWithinOneCalendarYear(source, ctx.asOfDate)).length, cited.length));
  },

  accepted_cited_ratio: async (ctx) => {
    const cited = await citedSources(ctx);
    return global(ratio(cited.filter(isAcceptedSource).length, cited.length));
  },

  /** Not the complement of accepted_cited_ratio. A record with neither a DOI
   * nor an arXiv id — a workshop page, a technical report — is neither
   * accepted nor arXiv-only, and treating one as `1 - other` would silently
   * reclassify it. */
  cited_arxiv_only_ratio: async (ctx) => {
    const cited = await citedSources(ctx);
    return global(ratio(cited.filter(isArxivOnlySource).length, cited.length));
  },

  /** One entry per configured cell. The previous design reported the minimum
   * across cells, which says something is short without saying which, so no
   * repair could be targeted at it. */
  taxonomy_cell_ab_sources: async (ctx) => {
    const config = await loadProjectConfigIfExists(ctx.workspaceDir);
    if (!config) throw new MeasurementUnavailable("longwrite.yaml is missing");
    const sources = await loadSources(ctx.workspaceDir);
    // The same counter the taxonomy gate uses, including its planned-query
    // provenance preference. A second implementation here would drift.
    const counts = await taxonomyCellCounts(
      ctx.workspaceDir, sources, config.research.taxonomy,
      config.research.corpus_gates.min_sources_per_taxonomy_cell);
    return counts.map((row) => ({
      scope_key: scopeKey("taxonomy_cell", row.cell), value: row.source_count,
    }));
  },
};
