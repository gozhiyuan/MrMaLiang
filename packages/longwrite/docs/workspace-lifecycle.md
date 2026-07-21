# Workspace Retention, Archives, and Provenance

LongWrite workspaces are durable research records by default. A completed run
keeps its full text, evidence chunks, citation ledger, reviews, flow trace, and
final paper so it can be resumed, audited, or reviewed later. It does not
silently clean those artifacts after a run.

Every successful `longwrite run` writes an append-only record under
`reports/run-provenance/`. The record includes the LongWrite package/Git
revision, MalaClaw command and version, optional `MALACLAW_SOURCE_DIR` Git
revision, selected runtime and runtime profile, provider/model policy,
configuration and corpus hashes, and checksums for available final artifacts.
When MalaClaw flow state exists, it also captures the requested and actual
runtime/model for each completed unit (including a runtime fallback). It never
reads `.env` or writes API keys into provenance.

For a public example that claims a specific model, configure that model
explicitly in the selected runtime profile or stage override. If a harness uses
its own unpinned default, provenance records the runtime but leaves the model
unset rather than falsely claiming an exact model identity.

## Retention operations

```bash
# Mark the workspace as an audit/review record; no artifacts are deleted.
maliang writing workspace keep my-survey --note "Flagship V1 evidence record"

# Create archives/<timestamp>.tar.gz plus a checksum manifest.
maliang writing workspace archive my-survey

# Preview only. This does not remove anything.
maliang writing workspace prune my-survey

# Remove only rebuildable caches/intermediates after verifying an archive.
maliang writing workspace prune my-survey --execute
```

`archive` includes the canonical configuration, manuscript, source/evidence
records, figures/tables, reviews, reports, and MalaClaw flow trace. Its sidecar
manifest records a SHA-256 checksum for the archive and every archived file.

`prune` is opt-in and dry-run by default. `--execute` requires a verified
archive and is restricted to `evidence/index.sqlite` plus LaTeX build
intermediates such as `.aux` and `.log`. It never removes `fulltext/*.md`,
`evidence/chunks.jsonl`, source packets, citation ledger, flow logs, canonical
paper sources, or `build/manuscript.pdf`.

The SQLite FTS index is safe to prune because it is derived from the canonical
chunk store and can be rebuilt with `longwrite evidence index <workspace>`.

## Public examples and reproducibility

Commit small example inputs, templates, configuration, and a provenance
record. Store selected PDFs and full release bundles as GitHub Release assets,
an artifact store, or an archival service; do not add a growing history of
generated PDFs or raw workspace snapshots to normal Git history. A published
example should link its release artifact and retain its provenance record so a
reader can identify the LongWrite/MalaClaw/runtime/model policy used to create
it.
