import type { RawSource, ScoredSource } from "./types.js";

/** LQS is intentionally deterministic and inspectable. It uses only fields
 * returned by providers; unknown metadata receives a conservative score rather
 * than an invented venue or acceptance claim. */

function termMatches(source: RawSource): number {
  const haystack = `${source.title} ${source.abstract}`.toLowerCase();
  return source.topics.filter((topic) => haystack.includes(topic.toLowerCase())).length;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function recencyScore(year: number): number {
  const age = Math.max(0, new Date().getFullYear() - year);
  if (age <= 0) return 1;
  if (age === 1) return 0.8;
  if (age === 2) return 0.5;
  if (age === 3) return 0.3;
  return 0.1;
}

function impactScore(source: RawSource): number {
  const citations = source.metrics?.citation_count;
  if (citations === undefined) return 0.25;
  const ageMonths = Math.max(6, (new Date().getFullYear() - source.year + 1) * 12);
  const perMonth = citations / ageMonths;
  if (perMonth >= 50) return 1;
  if (perMonth >= 10) return 0.8;
  if (perMonth >= 3) return 0.6;
  if (perMonth >= 1) return 0.4;
  return 0.2;
}

function venueScore(source: RawSource): number {
  const venue = source.venue.toLowerCase();
  if (/(neurips|iclr|icml|aaai|ijcai|acl|emnlp|naacl|cvpr|iccv|eccv|nature|science|jmlr|t-pami)/.test(venue)) return 1;
  if (/(workshop|arxiv|preprint|unknown)/.test(venue)) return venue.includes("workshop") ? 0.4 : 0.25;
  return source.venue.trim().length > 0 ? 0.7 : 0.2;
}

function acceptanceScore(source: RawSource): number {
  if (source.identifiers?.doi) return 1;
  if (source.venue && !/(arxiv|preprint|unknown)/i.test(source.venue)) return 0.75;
  return source.identifiers?.arxiv_id ? 0.35 : 0.2;
}

export function scoreSources(sources: RawSource[]): ScoredSource[] {
  return sources.map((source) => {
    const relevance = clamp(0.45 + termMatches(source) * 0.12);
    const recency = recencyScore(source.year);
    const impact = impactScore(source);
    const venue = venueScore(source);
    const acceptance = acceptanceScore(source);
    const quality = clamp(
      recency * 0.30 + impact * 0.25 + venue * 0.20 + relevance * 0.15 + acceptance * 0.10,
    );
    return {
      ...source,
      quality_score: Number(quality.toFixed(2)),
      score_rationale:
        `LQS=${(quality * 10).toFixed(1)}/10: recency ${(recency * 10).toFixed(1)}, ` +
        `impact ${(impact * 10).toFixed(1)}, venue ${(venue * 10).toFixed(1)}, ` +
        `relevance ${(relevance * 10).toFixed(1)}, acceptance ${(acceptance * 10).toFixed(1)}.`,
    };
  }).sort((a, b) => b.quality_score - a.quality_score || b.year - a.year);
}
