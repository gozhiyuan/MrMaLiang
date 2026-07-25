/**
 * Evidence module (MM-1.2).
 *
 * Owns everything between "a source exists" and "this claim is backed by an
 * exact locator in that source": retrieval, screening, full-text ingestion,
 * metadata enrichment, the evidence index, per-section allocation, the
 * citation ledger, and the corpus gates.
 *
 * ## Non-negotiables this module preserves
 *
 *  - **Exact locator validation is unchanged.** A claim without a precise
 *    locator is unsupported, not merely under-cited.
 *  - **SQLite FTS paths are unchanged.** The evidence index keeps its existing
 *    storage layout; a search that worked before must return the same rows.
 *  - **Hybrid embedding stays optional.** Semantic screening is an opt-in
 *    breadth tool, never a prerequisite for provenance.
 *  - **The seed provider stays visibly non-live.** Seeded corpora must never
 *    be mistakable for real retrieval in a report.
 *
 * ## Boundary
 *
 * In scope: retrieval and screening, full-text, enrichment, evidence index and
 * search, section allocation, ledger construction, corpus gates.
 *
 * Out of scope: source identity and URL verification (citation module),
 * repository artifacts (repository module), prose (manuscript modules).
 *
 * ## Status
 *
 * Facade over `src/lib/research/`. See the citation module for why the
 * boundary lands before the physical move.
 */

// ── Contracts ────────────────────────────────────────────────────────────────
export type {
  EvidenceLocator,
  EvidenceChunk,
  EvidencePacket,
  CitationLedgerEntry,
} from "../../lib/research/evidence.js";
export type { SemanticCandidateSet, SourceEvidencePackets } from "../../lib/research/semantic-screen.js";
export type { FulltextFetch, PdfTextExtractor, FulltextOptions, FulltextResult } from "../../lib/research/fulltext.js";
export type { MetadataUpgrade } from "../../lib/research/enrich.js";
export type { CorpusGateFinding, CorpusGateReport } from "../../lib/research/corpus-gates.js";

// ── Retrieval and screening ──────────────────────────────────────────────────
export {
  SEMANTIC_CANDIDATES_PATH,
  SEMANTIC_SCREEN_PATH,
  SOURCE_EVIDENCE_CANDIDATES_PATH,
  SOURCE_EVIDENCE_PATH,
  selectSemanticCandidates,
  repairSemanticScreen,
  selectSourceEvidenceCandidates,
  repairSourceEvidencePackets,
  finalizeEvidenceBackedDepth,
} from "../../lib/research/semantic-screen.js";
export { htmlToText, ingestFulltext } from "../../lib/research/fulltext.js";
export { enrichSourceMetadata } from "../../lib/research/enrich.js";

// ── Index, search and allocation ─────────────────────────────────────────────
export {
  buildEvidenceIndex,
  searchEvidence,
  sourceMatchesTaxonomy,
  allocateSectionEvidence,
} from "../../lib/research/evidence.js";

// ── Ledger ───────────────────────────────────────────────────────────────────
export {
  consolidateCitationLedger,
  validateEvidenceLedger,
  auditCitationEvidence,
} from "../../lib/research/evidence.js";

// ── Corpus gates ─────────────────────────────────────────────────────────────
export {
  evaluateCorpusGates,
  corpusGateReportToMarkdown,
  writeCorpusGateReport,
} from "../../lib/research/corpus-gates.js";

/** Subcommands this module owns, per the MM-0.2 inventory. */
export const EVIDENCE_SUBCOMMANDS = {
  recall: ["research", "recall"],
  score: ["research", "score"],
  classify: ["research", "classify"],
  enrich: ["research", "enrich"],
  snowball: ["research", "snowball"],
  fulltext: ["research", "fulltext"],
  corpusGates: ["research", "corpus-gates"],
  selectSemanticCandidates: ["research", "select-semantic-candidates"],
  selectSourceEvidenceCandidates: ["research", "select-source-evidence-candidates"],
  finalizeEvidenceDepth: ["research", "finalize-evidence-depth"],
  index: ["evidence", "index"],
  allocate: ["evidence", "allocate"],
} as const satisfies Record<string, readonly string[]>;
