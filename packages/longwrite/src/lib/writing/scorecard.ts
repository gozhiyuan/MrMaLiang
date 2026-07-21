import { z } from "zod";

/** AutoResearch-style multi-persona review scorecard.
 *
 *  The review/revise worker (an LLM) writes reviews/scorecard.json with one
 *  entry per reviewer persona. The deterministic scorer below — not the
 *  LLM — computes the official review_score: per-persona mean, median across
 *  personas, then anti-inflation caps. stop_when reads the scorer's output,
 *  so a worker cannot pass the revision loop by asserting a number. */

export const SCORE_DIMENSIONS = [
  "novelty",
  "comprehensiveness",
  "clarity",
  "technical_depth",
  "experimental_validation",
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** A survey has no obligation to invent or run experiments. Its quality gate
 * evaluates the literature work instead: breadth, evidence precision, and
 * synthesis across source families. */
export const SURVEY_SCORE_DIMENSIONS = [
  "scope_coverage",
  "evidence_fidelity",
  "comparative_synthesis",
  "literature_quality",
  "clarity",
] as const;
export type ResearchPaperKind = "survey" | "empirical";

/** Review dimensions per artifact type. Research keeps the AutoResearch
 *  set; novels and technical books get craft-appropriate axes so the
 *  reviewer personas score what actually matters for that artifact. */
const TECHNICAL_BOOK_DIMENSIONS = ["technical_accuracy", "clarity", "structure", "example_quality", "completeness"] as const;

export const ARTIFACT_DIMENSIONS: Record<string, readonly string[]> = {
  novel: ["plot_coherence", "character_consistency", "continuity", "pacing", "prose_quality"],
  technical_book: TECHNICAL_BOOK_DIMENSIONS,
  // The technical_book mode declares artifact_type "book".
  book: TECHNICAL_BOOK_DIMENSIONS,
};

export function dimensionsForArtifact(
  artifactType?: string,
  researchPaperKind: ResearchPaperKind = "empirical",
): readonly string[] {
  if (artifactType === "research_paper") {
    return researchPaperKind === "survey" ? SURVEY_SCORE_DIMENSIONS : SCORE_DIMENSIONS;
  }
  return (artifactType !== undefined && ARTIFACT_DIMENSIONS[artifactType]) || SCORE_DIMENSIONS;
}

export const REVIEW_PERSONAS = [
  "experimentalist",
  "theorist",
  "perfectionist",
  "synthesizer",
  "newcomer",
] as const;

/** First-round scores are capped here regardless of persona enthusiasm. */
export const ROUND_ONE_CAP = 7.0;
/** A single revision round may improve the official score by at most this. */
export const MAX_GAIN_PER_ROUND = 1.5;

export const Weakness = z.object({
  category: z.string().min(1),
  detail: z.string().min(1),
  severity: z.enum(["minor", "major", "critical"]).default("major"),
});
export type Weakness = z.infer<typeof Weakness>;

export function scorecardSchema(dimensions: readonly string[] = SCORE_DIMENSIONS) {
  const dimensionScores = z.object(
    Object.fromEntries(dimensions.map((d) => [d, z.number().min(0).max(10)])) as Record<string, z.ZodNumber>,
  );
  return z.object({
    version: z.literal(1).default(1),
    topic: z.string().optional(),
    personas: z.array(z.object({
      id: z.string().min(1),
      scores: dimensionScores,
      weaknesses: z.array(Weakness).default([]),
      summary: z.string().optional(),
    })).min(3, "at least 3 reviewer personas required"),
  });
}

/** Research-dimension scorecard, kept as the default schema. */
export const Scorecard = scorecardSchema();
export type Scorecard = z.infer<typeof Scorecard>;
export type PersonaReview = Scorecard["personas"][number];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type ScoreResult = {
  /** Official score after caps — what stop_when should compare against. */
  reviewScore: number;
  /** Median of persona overalls before caps. */
  rawMedian: number;
  personaOverall: Record<string, number>;
  dimensionMedians: Record<string, number>;
  round: number;
  capsApplied: string[];
};

/** previousScores: official scores from earlier rounds, oldest first. */
export function computeReviewScore(
  scorecard: Scorecard,
  previousScores: number[],
  dimensions: readonly string[] = SCORE_DIMENSIONS,
): ScoreResult {
  const personaOverall: Record<string, number> = {};
  for (const persona of scorecard.personas) {
    const values = dimensions.map((d) => persona.scores[d]);
    personaOverall[persona.id] = round1(values.reduce((a, b) => a + b, 0) / values.length);
  }
  const rawMedian = round1(median(Object.values(personaOverall)));

  const dimensionMedians = Object.fromEntries(
    dimensions.map((d) => [d, round1(median(scorecard.personas.map((p) => p.scores[d])))]),
  ) as Record<string, number>;

  const round = previousScores.length + 1;
  const capsApplied: string[] = [];
  let reviewScore = rawMedian;

  if (round === 1 && reviewScore > ROUND_ONE_CAP) {
    reviewScore = ROUND_ONE_CAP;
    capsApplied.push(`round-1 cap: raw ${rawMedian} capped at ${ROUND_ONE_CAP}`);
  }
  if (round > 1) {
    // The gain cap fights inflation near the top, not recovery from the
    // bottom: a low earlier score (e.g. an honest 0.9 on scaffold drafts)
    // must not force later rounds to ladder-climb in +1.5 steps while raw
    // quality is already mid-range. The ceiling therefore never drops below
    // the round-1 cap — observed in the tool-use-survey flagship run, where
    // rounds 2-3 spent tokens climbing the cap rather than the quality.
    const previous = previousScores[previousScores.length - 1];
    const ceiling = round1(Math.max(previous + MAX_GAIN_PER_ROUND, ROUND_ONE_CAP));
    if (reviewScore > ceiling) {
      capsApplied.push(`per-round gain cap: raw ${rawMedian} capped at ${ceiling} (max(previous ${previous} + ${MAX_GAIN_PER_ROUND}, ${ROUND_ONE_CAP}))`);
      reviewScore = ceiling;
    }
  }

  return { reviewScore: round1(reviewScore), rawMedian, personaOverall, dimensionMedians, round, capsApplied };
}

// ── Weakness routing ─────────────────────────────────────────────────────────

export type RoutingTarget = {
  stage: string;
  action: string;
};

const CATEGORY_ROUTES: Array<{ pattern: RegExp; targets: RoutingTarget[] }> = [
  {
    pattern: /citation|source|evidence|reference|bibliograph/i,
    targets: [
      { stage: "recall", action: "expand source recall, then re-run score/classify/full-text indexing before revising prose" },
    ],
  },
  {
    pattern: /structure|organi[sz]ation|outline|ordering|flow/i,
    targets: [{ stage: "outline", action: "revise the outline; downstream chapters must follow the updated section contract" }],
  },
  {
    pattern: /figure|table|visuali[sz]ation|diagram|chart/i,
    targets: [{ stage: "build", action: "add or regenerate figures/tables before rebuilding the manuscript" }],
  },
  {
    pattern: /coverage|depth|completeness|missing topic/i,
    targets: [
      { stage: "recall", action: "broaden recall for the under-covered areas, then refresh source classification and evidence packets" },
      { stage: "revise", action: "deepen the affected chapters once sources exist" },
    ],
  },
  // Fiction/long-form categories.
  {
    pattern: /continuity|character|point of view|pov/i,
    targets: [
      { stage: "character_bible", action: "reconcile the character bible with the flagged chapters" },
      { stage: "revise", action: "fix the continuity breaks in the affected chapters" },
    ],
  },
  {
    pattern: /world|setting|lore|geograph/i,
    targets: [{ stage: "world_bible", action: "update the world bible, then revise chapters that contradict it" }],
  },
  {
    pattern: /\bplot\b|arc|pacing|stakes/i,
    targets: [{ stage: "plot_outline", action: "adjust the plot outline / chapter arcs before revising prose" }],
  },
  // Technical-book categories.
  {
    pattern: /example|code|snippet|exercise/i,
    targets: [{ stage: "revise", action: "add or fix the examples/code for the flagged chapters and re-run code validation" }],
  },
  {
    pattern: /terminolog|prerequisite|jargon/i,
    targets: [{ stage: "revise", action: "align terminology with the glossary and fill prerequisite gaps" }],
  },
  // clarity | prose | style | anything unrecognized → revise
];

const DEFAULT_ROUTE: RoutingTarget = { stage: "revise", action: "address in the next revision round" };

export type RoutedWeakness = Weakness & { personaId: string; targets: RoutingTarget[] };

/** Map each persona-reported weakness to the workflow stage that fixes it.
 *  Unknown categories deliberately route to revise — fail toward the cheap,
 *  always-present stage rather than dropping the finding. */
export function routeWeaknesses(scorecard: Scorecard): RoutedWeakness[] {
  const routed: RoutedWeakness[] = [];
  for (const persona of scorecard.personas) {
    for (const weakness of persona.weaknesses) {
      const match = CATEGORY_ROUTES.find((r) => r.pattern.test(weakness.category));
      routed.push({ ...weakness, personaId: persona.id, targets: match?.targets ?? [DEFAULT_ROUTE] });
    }
  }
  const severityRank = { critical: 0, major: 1, minor: 2 };
  return routed.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}
