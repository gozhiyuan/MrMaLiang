import fs from "node:fs/promises";
import path from "node:path";
import { chapterFiles, citedSourceIds } from "../../validation/research.js";
import { citationMarkers } from "../../research/citation-markers.js";
import { computeRedundancy } from "../../research/redundancy.js";
import { detectContradictions, type ClaimJudgment } from "../../research/contradiction.js";
import {
  LandmarkCandidates, computeLandmarkCoverage, matchLandmarksToCorpus,
} from "../../research/landmark.js";
import type { ClassifiedSource } from "../../research/types.js";
import { GLOBAL_SCOPE, sectionDepthScope } from "../scope.js";
import { MeasurementUnavailable, type EvaluatorContext, type EvaluatorFn, type ScopedValue } from "./corpus.js";

const global = (value: number): ScopedValue[] => [{ scope_key: GLOBAL_SCOPE, value }];
const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

async function readOrUnavailable(workspaceDir: string, rel: string): Promise<string> {
  const content = await fs.readFile(path.join(workspaceDir, rel), "utf-8").catch(() => null);
  if (content === null) throw new MeasurementUnavailable(`${rel} is missing`);
  return content;
}

async function sources(workspaceDir: string): Promise<ClassifiedSource[]> {
  const rel = "sources/classified_sources.jsonl";
  const raw = await readOrUnavailable(workspaceDir, rel);
  return raw.split("\n").filter((line) => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line) as ClassifiedSource;
    } catch {
      throw new Error(`malformed source record at ${rel}:${index + 1}`);
    }
  });
}

async function chapters(ctx: EvaluatorContext): Promise<Array<{ rel: string; content: string }>> {
  const found = await chapterFiles(ctx.workspaceDir);
  if (found.length === 0) throw new MeasurementUnavailable("chapters/ holds no prose to measure");
  return found;
}

/** `pdfinfo` on a built manuscript. Absent means the measurement cannot be
 * taken, not that the density is zero — a paper with no PDF has no pages, and
 * dividing by that is a fabricated number rather than a small one. */
async function pdfPageCount(workspaceDir: string): Promise<number> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const pdf = path.join(workspaceDir, "build", "manuscript.pdf");
  if ((await fs.stat(pdf).catch(() => null)) === null) {
    throw new MeasurementUnavailable("build/manuscript.pdf has not been rendered");
  }
  const { stdout } = await run("pdfinfo", [pdf], { timeout: 10_000 })
    .catch(() => { throw new MeasurementUnavailable("pdfinfo could not read build/manuscript.pdf"); });
  const match = stdout.match(/^Pages:\s+(\d+)\s*$/m);
  if (!match) throw new MeasurementUnavailable("pdfinfo reported no page count");
  return Number(match[1]);
}

/** The section id is the chapter filename without its extension, which is the
 * same key the acceptance criteria and the repair packets use. */
const sectionId = (rel: string): string => path.basename(rel).replace(/\.md$/, "");

async function landmarkCoverage(ctx: EvaluatorContext): Promise<{ evidence: number; cited: number }> {
  const raw = await readOrUnavailable(ctx.workspaceDir, "research/landmark-candidates.json");
  let parsed;
  try {
    parsed = LandmarkCandidates.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`research/landmark-candidates.json is invalid: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const canonical = parsed.candidates.filter((candidate) => candidate.confidence !== "low");
  if (canonical.length === 0) {
    throw new MeasurementUnavailable("the landmark scout produced no high or medium confidence candidates");
  }
  // Only A/B records count as evidence: a landmark "covered" by a C-depth
  // skim is not covered in any sense a release gate should accept.
  const evidenceSources = (await sources(ctx.workspaceDir))
    .filter((source) => source.citation_depth === "A" || source.citation_depth === "B");
  const matches = matchLandmarksToCorpus(canonical, evidenceSources);
  const cited = citedSourceIds(await chapterFiles(ctx.workspaceDir));
  return {
    evidence: computeLandmarkCoverage(matches).coverageRatio,
    cited: computeLandmarkCoverage(matches.map((match) =>
      cited.has(match.matchedSourceId ?? "") ? match : { ...match, matchedSourceId: null, matchedBy: null },
    )).coverageRatio,
  };
}

export const MANUSCRIPT_EVALUATORS: Record<string, EvaluatorFn> = {
  /** One entry per section AND depth.
   *
   * The gate reads a separate minimum for A, B and C in every section, so a
   * per-section total cannot answer it: two A-depth plus two B-depth citations
   * and four B-depth citations both report four. */
  citation_depth_per_section: async (ctx) => {
    const byId = new Map((await sources(ctx.workspaceDir)).map((source) => [source.id, source]));
    return (await chapters(ctx)).flatMap((chapter) => {
      const cited = [...new Set(citationMarkers(chapter.content).map((marker) => marker.sourceId))]
        .map((id) => byId.get(id))
        .filter((source): source is ClassifiedSource => Boolean(source));
      return (["A", "B", "C"] as const).map((depth) => ({
        scope_key: sectionDepthScope(sectionId(chapter.rel), depth),
        value: cited.filter((source) => source.citation_depth === depth).length,
      }));
    });
  },

  citations_per_page: async (ctx) => {
    const prose = await chapters(ctx);
    const total = prose.reduce((sum, chapter) => sum + citationMarkers(chapter.content).length, 0);
    return global(ratio(total, await pdfPageCount(ctx.workspaceDir)));
  },

  /** A gate status as a number the kernel can compare: 1 when every marker
   * resolves to a known record, 0 when any does not. */
  citation_verification_status: async (ctx) => {
    const known = new Set((await sources(ctx.workspaceDir)).map((source) => source.id));
    const dangling = (await chapters(ctx))
      .flatMap((chapter) => citationMarkers(chapter.content))
      .filter((marker) => !known.has(marker.sourceId));
    return global(dangling.length === 0 ? 1 : 0);
  },

  prose_redundancy: async (ctx) => {
    const prose = await chapters(ctx);
    // Thresholds of zero so every repetition is counted: this is a measurement,
    // not the gate, and the gate's own thresholds are applied against the value.
    const report = computeRedundancy(prose, { maxTrackedOccurrences: 0, maxNgramOccurrences: 1 });
    const repeated = [...report.trackedPhraseOveruse, ...report.repeatedNgramOveruse]
      .reduce((sum, entry) => sum + entry.count, 0);
    return global(ratio(repeated, report.totalWords));
  },

  claim_contradictions: async (ctx) => {
    const raw = await fs.readFile(path.join(ctx.workspaceDir, "reviews", "claim-judgments.jsonl"), "utf-8")
      .catch(() => null);
    // No judgments recorded is an absent measurement, not zero contradictions:
    // nothing has looked for one yet.
    if (raw === null) throw new MeasurementUnavailable("reviews/claim-judgments.jsonl is missing");
    const judgments = raw.split("\n").filter((line) => line.trim() !== "")
      .map((line, index) => {
        try {
          return JSON.parse(line) as ClaimJudgment;
        } catch {
          throw new Error(`malformed claim judgment at reviews/claim-judgments.jsonl:${index + 1}`);
        }
      });
    return global(detectContradictions(judgments).length);
  },

  landmark_coverage_ratio: async (ctx) => global((await landmarkCoverage(ctx)).evidence),

  landmark_citation_coverage_ratio: async (ctx) => global((await landmarkCoverage(ctx)).cited),

  /** Readiness is recorded by the outline review, not recomputed here: the
   * review is the artifact an operator approves, so measuring anything else
   * would report a readiness nobody signed off on. */
  outline_readiness: async (ctx) => {
    const outline = await fs.readFile(path.join(ctx.workspaceDir, "outline.md"), "utf-8").catch(() => null)
      ?? await fs.readFile(path.join(ctx.workspaceDir, "outline.json"), "utf-8").catch(() => null);
    if (outline === null) throw new MeasurementUnavailable("no outline has been drafted");
    const raw = await fs.readFile(path.join(ctx.workspaceDir, "reviews", "outline-review.json"), "utf-8")
      .catch(() => null);
    if (raw === null) return global(0);
    const review = JSON.parse(raw) as { ready?: boolean; approved?: boolean };
    return global(review.ready === true || review.approved === true ? 1 : 0);
  },
};
