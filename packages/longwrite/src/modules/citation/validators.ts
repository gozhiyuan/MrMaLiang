/**
 * Citation module — the deterministic gates it owns.
 *
 * `validateResearchWorkspace()` runs every research gate as one pass, so the
 * citation gates cannot be invoked in isolation today. Naming them here makes
 * the module's responsibility explicit and gives MM-2/MM-5 a concrete list to
 * split against — and MM-5.3 forbids collapsing any of them.
 */

export { validateResearchWorkspace, writeValidationReport } from "../../lib/validation/research.js";

/** Gate ids in `reports/validation.md` that belong to this module. */
export const CITATION_GATE_IDS = [
  "citation_evidence_ledger",
  "citation_markers_present",
  "citation_url_liveness",
  "citation_verification",
  "claim_support",
  "full_source_identity",
] as const;

export type CitationGateId = (typeof CITATION_GATE_IDS)[number];
