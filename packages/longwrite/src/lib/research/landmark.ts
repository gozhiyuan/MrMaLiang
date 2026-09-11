import fs from "node:fs/promises";
import path from "node:path";
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
  const containsSequence = (container: string[], sequence: string[]): boolean => {
    for (let i = 0; i + sequence.length <= container.length; i += 1) {
      if (sequence.every((token, offset) => container[i + offset] === token)) return true;
    }
    return false;
  };
  if (containsSequence(actual, wanted)) return true;
  // Landmark scouts sometimes record the full canonical title while a
  // provider returns its distinctive short title. Exact tokens avoid the old
  // substring false positives (STOP must never match "stopping"). A lone
  // abbreviated token must be distinctive enough not to be generic noise.
  if (actual.length === 1 && actual[0]!.length < 5) return false;
  return containsSequence(wanted, actual);
}

/** `matchedBy` says whether an identifier or the title matched; `method` says
 * WHICH rule did, because "we found it by arXiv id" and "we found it by DOI"
 * are different provenance claims about the same source. */
export type LandmarkMatch = {
  candidate: string;
  matchedSourceId: string | null;
  matchedBy: "identifier" | "title" | null;
  method: "arxiv_id" | "doi" | "title" | null;
};

/** Identifier matches are normalized but exact and unambiguous. Title matching
 * requires an exact contiguous token sequence in either direction, so a short
 * distinctive title can match its canonical long form without matching an
 * unrelated substring. */
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
      if (bySource) { used.add(bySource.id); return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const, method: "arxiv_id" as const }; }
    }
    if (doi) {
      const bySource = sources.find((source) => !used.has(source.id) && source.identifiers?.doi && normalizeDoi(source.identifiers.doi) === normalizeDoi(doi));
      if (bySource) { used.add(bySource.id); return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const, method: "doi" as const }; }
    }
    const normalizedName = normalize(candidate.name);
    const byTitle = sources.find((source) => !used.has(source.id) && titleMatches(normalizedName, source.title));
    if (byTitle) { used.add(byTitle.id); return { candidate: candidate.name, matchedSourceId: byTitle.id, matchedBy: "title" as const, method: "title" as const }; }
    return { candidate: candidate.name, matchedSourceId: null, matchedBy: null, method: null };
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

/** A landmark's identity, independent of whether it has been resolved yet.
 *
 * Keying on the resolved source id would make an unresolved target and its
 * later-discovered source two different targets, which is how a landmark that
 * arrives late looks like a landmark that was never requested. */
export function landmarkTargetKey(candidate: { name: string }): string {
  return `landmark:${normalize(candidate.name).replace(/\s+/g, "-")}`;
}

export const LandmarkResolution = z.object({
  target_key: z.string().min(1),
  candidate_name: z.string().min(1),
  resolved_source_id: z.string().min(1).nullable(),
  method: z.enum(["arxiv_id", "doi", "title", "unresolved"]),
  at: z.string().datetime(),
}).strict();
export type LandmarkResolution = z.infer<typeof LandmarkResolution>;

/** The corpus a resolution is matched against.
 *
 * A missing corpus is an empty one — nothing has been classified yet, and every
 * target is legitimately unresolved. A corpus that exists but cannot be read is
 * not: reporting that as "no sources" would record every landmark as missing
 * when the truth is that we could not look. */
async function readClassifiedSources(workspaceDir: string): Promise<ClassifiedSource[]> {
  const file = path.join(workspaceDir, "sources", "classified_sources.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return raw.split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ClassifiedSource);
}

/** Resolution reuses matchLandmarksToCorpus rather than reimplementing its
 * identifier-then-title matching.
 *
 * Every candidate produces a record, including the ones nothing matched: an
 * unfound landmark is a pending target, and omitting it is the difference
 * between "the search failed" and "nobody ever asked". */
export async function resolveLandmarkTargets(workspaceDir: string): Promise<LandmarkResolution[]> {
  const raw = await fs.readFile(path.join(workspaceDir, "research", "landmark-candidates.json"), "utf-8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (raw === null) return [];
  const parsed = LandmarkCandidates.parse(JSON.parse(raw));
  const sources = await readClassifiedSources(workspaceDir);
  const matches = matchLandmarksToCorpus(parsed.candidates, sources);
  const at = new Date().toISOString();
  return parsed.candidates.map((candidate) => {
    const match = matches.find((entry) => entry.candidate === candidate.name);
    return LandmarkResolution.parse({
      target_key: landmarkTargetKey(candidate),
      candidate_name: candidate.name,
      resolved_source_id: match?.matchedSourceId ?? null,
      method: match?.method ?? "unresolved",
      at,
    });
  });
}
