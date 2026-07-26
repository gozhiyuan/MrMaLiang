import { ReproductionClaim, ReproductionVerdict } from "@mr-maliang/research-protocol";
export function verifyReproductionVerdict(claimInput: unknown, verdictInput: unknown): ReturnType<typeof ReproductionVerdict.parse> {
  const claim = ReproductionClaim.parse(claimInput); const verdict = ReproductionVerdict.parse(verdictInput);
  if (verdict.claim_id !== claim.id) throw new Error("verdict claim_id does not match the anchored claim");
  if (verdict.verdict === "exact_reproduction" && claim.feasibility !== "exact") throw new Error("exact verdict requires exact claim feasibility");
  if (verdict.verdict === "blocked_missing_artifacts" && verdict.evidence_artifacts.length > 0) throw new Error("blocked verdict cannot claim evidence artifacts");
  if (verdict.verdict !== "not_attempted" && verdict.rationale.trim().length < 12) throw new Error("verdict rationale is too short for an audit record");
  return verdict;
}
