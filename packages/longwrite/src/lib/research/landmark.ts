import { z } from "zod";
import type { ClassifiedSource } from "./types.js";

export const LandmarkCandidate = z.object({
  name: z.string().min(1).max(200),
  why_canonical: z.string().min(20).max(600),
  expected_identifiers: z.object({
    arxiv_id: z.string().min(1).optional(),
    doi: z.string().min(1).optional(),
  }).strict().optional(),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

export const LandmarkCandidates = z.object({
  version: z.literal(1),
  candidates: z.array(LandmarkCandidate).min(1).max(30),
}).strict();
export type LandmarkCandidates = z.infer<typeof LandmarkCandidates>;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export type LandmarkMatch = { candidate: string; matchedSourceId: string | null; matchedBy: "identifier" | "title" | null };

/** Identifier matches are exact and unambiguous. Title matches fall back to a
 * substring check on normalized text, sufficient for a short-title landmark
 * work (e.g. "AFlow", "Promptbreeder") without requiring exact title casing
 * or venue suffixes to line up. */
export function matchLandmarksToCorpus(
  candidates: LandmarkCandidates["candidates"],
  sources: ClassifiedSource[],
): LandmarkMatch[] {
  return candidates.map((candidate) => {
    const arxivId = candidate.expected_identifiers?.arxiv_id;
    const doi = candidate.expected_identifiers?.doi;
    if (arxivId) {
      const bySource = sources.find((source) => source.identifiers?.arxiv_id === arxivId);
      if (bySource) return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const };
    }
    if (doi) {
      const bySource = sources.find((source) => source.identifiers?.doi === doi);
      if (bySource) return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const };
    }
    const normalizedName = normalize(candidate.name);
    const byTitle = sources.find((source) => {
      const normalizedTitle = normalize(source.title);
      return normalizedTitle.length > 0 && (normalizedTitle.includes(normalizedName) || normalizedName.includes(normalizedTitle));
    });
    if (byTitle) return { candidate: candidate.name, matchedSourceId: byTitle.id, matchedBy: "title" as const };
    return { candidate: candidate.name, matchedSourceId: null, matchedBy: null };
  });
}

export type LandmarkCoverageResult = { total: number; matched: number; coverageRatio: number; unmatched: string[] };

export function computeLandmarkCoverage(matches: LandmarkMatch[]): LandmarkCoverageResult {
  const matched = matches.filter((match) => match.matchedSourceId !== null);
  return {
    total: matches.length,
    matched: matched.length,
    coverageRatio: matches.length === 0 ? 1 : matched.length / matches.length,
    unmatched: matches.filter((match) => match.matchedSourceId === null).map((match) => match.candidate),
  };
}
