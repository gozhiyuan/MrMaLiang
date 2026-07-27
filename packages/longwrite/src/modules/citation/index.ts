/**
 * Citation module (MM-1.1).
 *
 * Owns source identity, BibTeX generation, citation markers, the citation
 * plan/ledger, and URL verification — everything that answers "which source
 * backs this claim, and can a reader find it?".
 *
 * ## Boundary
 *
 * In scope: source identity reconciliation, BibTeX, citation markers, citation
 * plan/ledger construction, cited-URL verification, and the citation release
 * gates.
 *
 * Out of scope: retrieving or screening sources (evidence module), repository
 * artifacts (repository module), and prose (manuscript modules). Citation
 * quality metrics are computed by the deterministic scorer, never by a judge.
 *
 * ## Status
 *
 * This is a facade. Implementations still live under `src/lib/research/` and
 * are re-exported here, which the plan explicitly permits ("move OR
 * re-export"). Establishing the boundary with zero behavioral risk keeps the
 * MM-0 golden manifests passing; the physical move becomes a later mechanical
 * step. Existing `src/lib/research/...` imports keep working throughout.
 */

export * from "./contracts.js";
export * from "./commands.js";
export * from "./validators.js";

// ── Source identity ──────────────────────────────────────────────────────────
export { reconcileSourceIdentity, reconcileWorkspaceSources } from "../../lib/research/identity.js";

// ── BibTeX ───────────────────────────────────────────────────────────────────
export { escapeBibtex, bibtexKey, bibtexKeys, writeBibtex } from "../../lib/research/bibtex.js";

// ── Citation markers and plan ────────────────────────────────────────────────
export { parseCitationMarker, citationMarkers } from "../../lib/research/citation-markers.js";
export { buildCitationPlan } from "../../lib/research/citation-plan.js";

// ── Verification ─────────────────────────────────────────────────────────────
export { verifyCitedSourceUrls } from "../../lib/research/verify.js";
