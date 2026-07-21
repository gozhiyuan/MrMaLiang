import type { CitationDepth, ClassifiedSource, ScoredSource } from "./types.js";

function depth(score: number): CitationDepth {
  if (score >= 0.82) return "A";
  if (score >= 0.72) return "B";
  // Keyless providers often return a relevant arXiv record before a venue or
  // citation-metric upgrade is available. A deterministic LQS around 0.6 is
  // incomplete metadata, not evidence of low topical value. Keep these as C
  // candidates so full-text retrieval can verify them; A/B stay stricter.
  if (score >= 0.52) return "C";
  return "D";
}

export function classifySources(sources: ScoredSource[]): ClassifiedSource[] {
  return sources.map((source) => {
    const citation_depth = depth(source.quality_score);
    return {
      ...source,
      citation_depth,
      citation_depth_rationale:
        citation_depth === "A"
          ? "High priority source for direct section grounding."
          : citation_depth === "B"
            ? "Useful supporting source for section context."
            : citation_depth === "C"
              ? "Background source; cite selectively."
              : "Low priority until verified by stronger metadata.",
    };
  });
}
