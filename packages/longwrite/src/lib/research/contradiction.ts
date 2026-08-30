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

function normalizeSubjectKey(subjectKey: string): string {
  return subjectKey.trim().toLowerCase();
}

function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Groups double-reviewed sampled claims by their normalized (trimmed,
 * lowercased) subject_key. `claim_judge` writes TWO independent judgments
 * per sample_id (reviewer_a and reviewer_b) for the same claim in the same
 * chapter, so a same-chapter affirm/deny split between those two reviewers
 * is a normal, expected outcome of the double-review design — not a
 * cross-section contradiction. A group is flagged only when its affirming
 * and denying judgments do NOT fully coincide on the same set of chapters
 * (i.e. at least one chapter holds an affirms with no matching denies there,
 * or a denies with no matching affirms there). Two sections both qualifying
 * the same claim is caution, not conflict, and is deliberately not flagged;
 * a qualifies-only chapter is also never reported as "implicated" even when
 * it shares a subject_key with a genuine affirm/deny disagreement elsewhere. */
export function detectContradictions(judgments: ClaimJudgment[]): ContradictionGroup[] {
  const bySubject = new Map<string, ClaimJudgment[]>();
  for (const judgment of judgments) {
    if (!judgment.subject_key || !judgment.polarity) continue;
    const subjectKey = normalizeSubjectKey(judgment.subject_key);
    const group = bySubject.get(subjectKey) ?? [];
    group.push(judgment);
    bySubject.set(subjectKey, group);
  }
  const contradictions: ContradictionGroup[] = [];
  for (const [subject_key, claims] of bySubject) {
    const affirms = claims.filter((claim) => claim.polarity === "affirms");
    const denies = claims.filter((claim) => claim.polarity === "denies");
    if (affirms.length === 0 || denies.length === 0) continue;
    const affirmChapters = new Set(affirms.map((claim) => claim.chapter));
    const denyChapters = new Set(denies.map((claim) => claim.chapter));
    if (setsEqual(affirmChapters, denyChapters)) continue;
    const implicatedChapters = new Set([...affirmChapters, ...denyChapters]);
    contradictions.push({ subject_key, chapters: [...implicatedChapters], claims: [...affirms, ...denies] });
  }
  return contradictions;
}
