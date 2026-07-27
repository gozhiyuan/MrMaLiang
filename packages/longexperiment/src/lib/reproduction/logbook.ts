import type { ReproductionVerdict as ReproductionVerdictType } from "@mr-maliang/research-protocol";
import type { PaperSource } from "./paper-source.js";
export function reproductionLogbook(source: PaperSource, verdicts: ReproductionVerdictType[]): string {
  return ["# Reproduction logbook", "", "- Source: " + source.locator, "- Source checksum: " + source.checksum, "", "## Claim verdicts", "", ...verdicts.flatMap((verdict) => [
    "### " + verdict.claim_id + " — " + verdict.verdict, "", verdict.rationale, "",
    "- Trials: " + (verdict.trial_ids.join(", ") || "none"),
    "- Evidence: " + (verdict.evidence_artifacts.join(", ") || "none"),
    ...(verdict.deviations.length ? ["- Deviations: " + verdict.deviations.join("; ")] : []), "",
  ])].join("\n");
}
