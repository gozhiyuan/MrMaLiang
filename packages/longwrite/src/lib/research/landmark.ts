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
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    const key = normalize(candidate.name);
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["candidates", index, "name"], message: "duplicate normalized landmark name" });
    seen.add(key);
  });
});
export type LandmarkCandidates = z.infer<typeof LandmarkCandidates>;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeArxiv(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//, "").replace(/^arxiv:/, "").replace(/\.pdf$/, "").replace(/v\d+$/, "").trim();
}

function normalizeDoi(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "").trim();
}

function titleMatches(candidate: string, source: string): boolean {
  const wanted = normalize(candidate).split(" ").filter(Boolean);
  const actual = normalize(source).split(" ").filter(Boolean);
  if (wanted.length === 0 || actual.length === 0) return false;
  if (wanted.join(" ") === actual.join(" ")) return true;
  for (let i = 0; i + wanted.length <= actual.length; i += 1) {
    if (wanted.every((token, offset) => actual[i + offset] === token)) return true;
  }
  return false;
}

export type LandmarkMatch = { candidate: string; matchedSourceId: string | null; matchedBy: "identifier" | "title" | null };

/** Identifier matches are normalized but exact and unambiguous. Title matching
 * requires an exact contiguous token sequence, so a short landmark such as
 * "AFlow" can match a titled paper without matching an unrelated substring. */
export function matchLandmarksToCorpus(
  candidates: LandmarkCandidates["candidates"],
  sources: ClassifiedSource[],
): LandmarkMatch[] {
  const used = new Set<string>();
  return candidates.map((candidate) => {
    const arxivId = candidate.expected_identifiers?.arxiv_id;
    const doi = candidate.expected_identifiers?.doi;
    if (arxivId) {
      const bySource = sources.find((source) => !used.has(source.id) && source.identifiers?.arxiv_id && normalizeArxiv(source.identifiers.arxiv_id) === normalizeArxiv(arxivId));
      if (bySource) { used.add(bySource.id); return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const }; }
    }
    if (doi) {
      const bySource = sources.find((source) => !used.has(source.id) && source.identifiers?.doi && normalizeDoi(source.identifiers.doi) === normalizeDoi(doi));
      if (bySource) { used.add(bySource.id); return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const }; }
    }
    const normalizedName = normalize(candidate.name);
    const byTitle = sources.find((source) => !used.has(source.id) && titleMatches(normalizedName, source.title));
    if (byTitle) { used.add(byTitle.id); return { candidate: candidate.name, matchedSourceId: byTitle.id, matchedBy: "title" as const }; }
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
