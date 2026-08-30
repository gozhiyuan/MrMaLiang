export type ClaimJudgment = {
  sample_id: string;
  reviewer_id: string;
  source_id: string;
  chapter: string;
  claim: string;
  subject_key?: string;
  polarity?: "affirms" | "denies" | "qualifies";
  verdict: string;
};

export type ContradictionGroup = { subject_key: string; chapters: string[]; claims: ClaimJudgment[] };

/** Groups double-reviewed sampled claims by their normalized subject_key and
 * flags a group as contradictory only when it contains both an "affirms" and
 * a "denies" polarity spanning more than one chapter. Two sections both
 * qualifying the same claim is caution, not conflict, and is deliberately
 * not flagged. */
export function detectContradictions(judgments: ClaimJudgment[]): ContradictionGroup[] {
  const bySubject = new Map<string, ClaimJudgment[]>();
  for (const judgment of judgments) {
    if (!judgment.subject_key || !judgment.polarity) continue;
    const group = bySubject.get(judgment.subject_key) ?? [];
    group.push(judgment);
    bySubject.set(judgment.subject_key, group);
  }
  const contradictions: ContradictionGroup[] = [];
  for (const [subject_key, claims] of bySubject) {
    const polarities = new Set(claims.map((claim) => claim.polarity));
    const chapters = new Set(claims.map((claim) => claim.chapter));
    if (polarities.has("affirms") && polarities.has("denies") && chapters.size > 1) {
      contradictions.push({ subject_key, chapters: [...chapters], claims });
    }
  }
  return contradictions;
}
