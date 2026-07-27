/**
 * Citation module — the CLI subcommands its stages invoke.
 *
 * Derived from the MM-0.2 inventory (docs/internal/generated-stage-commands.md).
 * Naming them here means MM-2's compiler split has an explicit list to move,
 * and a stage that silently stops calling one of these shows up as a diff in
 * both the golden manifests and that inventory.
 */

/** `longwrite <subcommand>` invocations owned by the citation module. */
export const CITATION_SUBCOMMANDS = {
  /** Reconcile duplicate/aliased source identities into stable ids. */
  reconcileIdentities: ["research", "reconcile-identities"],
  /** Verify cited source URLs are live and match their metadata. */
  verify: ["research", "verify"],
  /** Build the citation ledger from chapter markers plus evidence packets. */
  consolidate: ["evidence", "consolidate"],
  /** Score claim support against the ledger. */
  audit: ["evidence", "audit"],
} as const satisfies Record<string, readonly string[]>;

export type CitationSubcommand = keyof typeof CITATION_SUBCOMMANDS;

/** Stage ids in the compiled manifests that invoke this module. */
export const CITATION_STAGE_IDS = [
  "identity_reconcile",
  "verify_citations",
  "final_release_verify_citations",
  "citation_ledger",
  "consolidate_citations",
  "evidence_audit",
] as const;
