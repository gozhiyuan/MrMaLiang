/**
 * Repository module (MM-1.3).
 *
 * Owns pinned source-code artifacts as evidence: snapshotting a repository at
 * an immutable revision, optional GitHub discovery, structural analysis, and
 * cross-repository comparison.
 *
 * ## Non-negotiables this module preserves
 *
 *  - **Repository evidence stays separate from scholarly literature metrics.**
 *    A pinned repo is not a paper; it must never be counted toward citation
 *    depth, venue quality, or recency ratios.
 *  - **The Git revision is immutable.** A snapshot is pinned to an exact
 *    commit, never a moving branch.
 *  - **Mentioned repositories are operator CANDIDATES, not evidence.** A model
 *    naming a repo does not make it citable; it must be pinned and selected
 *    first.
 *
 * ## Boundary
 *
 * In scope: repository pinning/snapshot, discovery, analysis packets,
 * comparison packets, and repository citation keys.
 *
 * Out of scope: scholarly retrieval and screening (evidence module), citation
 * ledger and URL verification (citation module).
 *
 * ## Status
 *
 * Facade over `src/lib/research/`. See the citation module for rationale.
 */

// ── Contracts ────────────────────────────────────────────────────────────────
export {
  CODEBASE_MARKER_RE,
  codebaseMarkerIds,
  canonicalRepositorySource,
  codebaseBibtexKey,
  CodebaseInput,
  DEFAULT_GITHUB_CODEBASE_DISCOVERY,
  GithubCodebaseDiscovery,
  CodebaseManifestRecord,
  CodebaseManifestIndex,
  loadCodebaseManifest,
} from "../../lib/research/codebase-contract.js";
export type {
  CodebaseConfig,
  GithubCodebaseDiscoveryConfig,
  CodebaseManifest,
} from "../../lib/research/codebase-contract.js";

// ── Snapshot ─────────────────────────────────────────────────────────────────
export { prepareCodebases, codebaseCitationKeys } from "../../lib/research/codebase.js";

// ── Discovery ────────────────────────────────────────────────────────────────
export type { DiscoveredCodebase } from "../../lib/research/github-codebase-discovery.js";
export {
  GithubCodebaseCandidates,
  GithubCodebaseSelection,
  discoverGithubCodebases,
  repairGithubCodebaseSelection,
  selectedGithubCodebases,
} from "../../lib/research/github-codebase-discovery.js";

// ── Analysis ─────────────────────────────────────────────────────────────────
export {
  CODEBASE_ANALYSIS_RAW_PATH,
  CODEBASE_ANALYSIS_PATH,
  CodebaseAnalysisPacket,
  repairCodebaseAnalysis,
} from "../../lib/research/codebase-analysis.js";

// ── Comparison ───────────────────────────────────────────────────────────────
export {
  CODEBASE_COMPARISON_RAW_PATH,
  CODEBASE_COMPARISON_PATH,
  CodebaseComparisonPacket,
  validateCodebaseComparison,
  repairCodebaseComparison,
} from "../../lib/research/codebase-comparison.js";

/** Subcommands this module owns, per the MM-0.2 inventory. */
export const REPOSITORY_SUBCOMMANDS = {
  prepare: ["research", "codebases"],
} as const satisfies Record<string, readonly string[]>;
