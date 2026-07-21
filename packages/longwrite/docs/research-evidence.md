# Research Evidence Pipeline

LongWrite research mode keeps a paper's literature corpus inside its workspace.
The cached documents are the source of truth; SQLite FTS is a rebuildable
lexical index, not opaque agent memory.

```text
query plan -> multi-provider recall -> citation graph expansion -> metadata fusion
  -> source identity reconciliation -> LQS/provisional classify
  -> (agentic live mode: abstract screen -> full text cache -> source evidence -> final A/B depth
      -> corpus assessment -> bounded evidence recovery when a gate fails -> hard corpus gate)
  -> evidence index -> outline -> (agentic live mode: audit -> critique -> revise -> re-audit) -> human approval
  -> section evidence packets -> draft -> citation ledger
  -> review -> targeted expansion -> revise -> double-review claim gate
  -> build + strict validation
```

## Codebase evidence is a separate citation channel

`research.codebases` accepts public Git URLs and local Git working trees. Once
the search plan is written, the flow uses Git to make a detached snapshot and
records its resolved commit—not a mutable branch name—in
`codebases/manifest.json`. It then writes bounded, human-inspectable codebase
context and line-range chunks. It never executes a repository while preparing a
paper.

```text
search plan -> (optional GitHub API recall -> README/topic screening -> selection)
  -> research.codebases[] -> Git snapshot at resolved SHA -> codebase chunks/context
  -> architecture dossier + repository comparison packet -> outline + chapter workers
  -> [codebase:<id>:path#Lx-Ly] marker
  -> @software entry in the final bibliography
```

This is separate from scholarly evidence. The codebase manifest, snapshots,
and `sources/codebases.bib` support factual statements about a repository's
architecture, interfaces, configuration, or declared behavior. They do not
count toward literature-quality, venue, recency, taxonomy, or woven scholarly
bibliography gates. Plain Git is enough to clone and pin an explicit public
repository; the GitHub API is only used when optional codebase discovery is
enabled. Future empirical execution belongs to LongExperiment and must use its
own preregistered/sandboxed result contract.

Repository identity is canonicalized before preparation, preventing an
explicit and discovered URL from pinning the same repository twice. Bounded
writer context interleaves chunks across repositories. `CITATION.cff` supplies
software bibliography metadata when available. README/CITATION GitHub links are
emitted as a bounded `mentioned-repositories.json` operator list with
`recursive_fetch_performed: false`; they are not evidence until explicitly
selected and pinned in a later run.

## Configure Retrieval

```yaml
research:
  provider: multi
  topic: Long-horizon memory and planning in LLM agents
  target_candidates: 300
  query_budget: 40
  taxonomy:
    - memory architecture
    - planning
    - tool use
  source_policy:
    min_recent_ratio: 0.4
    min_verified_ratio: 0.8
    max_arxiv_only_ratio: 0.6
    require_live_urls: false
  fulltext:
    max_core_sources: 40
    allow_pdf_download: true
  semantic_screen:
    enabled: true # agentic live-provider mode
    max_candidates: 100
    min_candidates_per_taxonomy_cell: 3
    max_evidence_sources: 32
    min_supported_claims_for_a: 2
    min_supported_claims_for_b: 1
  outline_review:
    enabled: true
    max_rounds: 2
  verification:
    max_sources: 30
  corpus_gates:
    min_candidates: 200
    min_sources_per_taxonomy_cell: 3
    min_core_sources: 20
    min_recent_ratio: 0.25
    min_source_type_diversity: 4
  writing_strategy: llm_sections
  retrieval:
    backend: sqlite_fts
    embedding_model: text-embedding-3-small
```

This example is the full/deep configuration, so it uses direct LLM section
drafting. Set `writing_strategy: scaffold_then_revise` for a lower-cost
structural rehearsal.

`target_candidates` is divided over executed query variants. A planner can
write up to `query_budget` variants; actual provider results can be lower due
to availability, deduplication, or exclusion terms.

In agentic mode, metadata LQS remains an inexpensive, reproducible triage
signal; it is not a claim that a model has read the paper. The optional
semantic bridge first asks an LLM to screen only the bounded candidate set from
title and abstract. It then retrieves full text only for selected candidates
and requires source-level, excerpt-validated evidence packets before a
metadata-provisional A/B source can retain final A/B depth. This keeps C-level
contextual coverage broad without pretending every recalled reference has
been read deeply.

If the evidence-backed corpus gate fails before outlining, the workflow does
not silently lower its target or continue with a thin bibliography. It records
the failed metric, runs at most two recovery rounds, and in each round asks the
LLM for one schema-validated `targeted_research_expansion` plan. Scripts then
recall, enrich, score, re-screen, fetch full text, validate packets, and
re-measure the same gate. The final gate remains hard: an unrecovered deficit
stops the flow with the report rather than producing an under-evidenced paper.

Before drafting, the live agentic workflow runs a separate bounded outline
loop: deterministic survey/structure audits → LLM critique grounded in source
packets → script-owned readiness score → LLM outline revision. Human approval
is queued only after the final re-audit passes. This is deliberately separate
from manuscript peer review because it tests the paper's intellectual
structure before any chapter prose exists.

`auto_research_agentic` is the default research workflow. It defaults to
`provider: multi` and the deep breadth profile, requires taxonomy-cell query
plans with at least three variants per cell, runs backward and forward Semantic
Scholar citation expansion, writes source identity/provenance records, enforces
`corpus_gates`, and requires the survey contract plus double-reviewed claim
gate before final release.

Live provider failures fail closed. `--allow-seed-fallback` is solely for
offline development and marks the resulting corpus as seed data. The `seed`
provider creates explicitly labelled synthetic metadata documents only to
exercise the offline evidence/citation contract; it is never external paper
text and is not a publishable literature corpus.

`writing_strategy` controls the foreach section stage:

- `scaffold_then_revise` is an explicit lower-cost option. A deterministic
  helper produces citation-marked section scaffolds, then the LLM
  review/revision loop improves them using evidence packets.
- `llm_sections` makes each section a direct worker task. Use it with
  `codex`, `claude-code`, or an API runtime that can produce one output file;
  the section evidence packet is injected as a bounded skill document. It is
  the default for `auto_research_agentic`; it is intentionally not the
  recommended `dry-run` path.

## Workspace Artifacts

```text
sources/documents/<source-id>.html|pdf  Original fetched material
sources/semantic-screening-candidates.json Script-bounded metadata candidates for abstract screening
sources/semantic-screening.json           LLM semantic-screen decisions (live agentic mode)
fulltext/<source-id>.md                 Extracted, citation-readable text
evidence/chunks.jsonl                   Stable chunks with source/locator
evidence/index.sqlite                   SQLite FTS index derived from chunks
evidence/source-packets.json            LLM claim packets with excerpt validation (live agentic mode)
evidence/section-<id>.json              Section-specific evidence packet
evidence/coverage.json                  Taxonomy and packet coverage report
evidence/citation-ledger.jsonl          Marker-to-evidence traceability
reports/run-provenance/<timestamp>.json Immutable run/runtime/config/corpus/output record
codebases/<id>/snapshot                  Detached Git snapshot (pinned source record)
codebases/manifest.json                  Requested ref and resolved commit per repository
codebases/github-candidates.json          API-recalled metadata and bounded README excerpts (optional)
codebases/github-selection.json           LLM-selected candidates before Git snapshotting (optional)
codebases/mentioned-repositories.json      Bounded, non-recursive operator candidate list
evidence/codebase-chunks.jsonl           Bounded code/doc line-range chunks
evidence/codebase-context.md             Writer context with valid codebase citation markers
evidence/codebase-analysis.json           Locator-validated architecture dossier
evidence/codebase-comparison.json         Locator-validated repository comparison synthesis
sources/codebases.bib                    Generated @software bibliography entries
```

Full-text ingestion reuses an existing complete cached document by default.
Run `longwrite research fulltext <workspace> --refresh` to fetch it again.
It ranks A/B sources first and then uses C candidates when provider metadata is
incomplete. C is not a claim of publication quality: it is an explicit
full-text verification candidate. D sources are only used as a last resort.

`evidence/index.sqlite` is a rebuildable FTS5 index, not the canonical source
record. Keep `fulltext/*.md` and `evidence/chunks.jsonl` for an auditable
flagship; archive them after release rather than deleting them. See
[workspace lifecycle](./workspace-lifecycle.md) for verified archives and
safe pruning.

## Commands

```bash
maliang writing research recall . --topic "..." --provider multi \
  --target-candidates 300 --query-budget 40
maliang writing research fulltext . --max-sources 40
maliang writing research enrich . --max-sources 20
maliang writing research snowball .
maliang writing research reconcile-identities .
maliang writing research corpus-gates .
maliang writing research survey-contract .
maliang writing research codebases .
maliang writing research github-codebase-recall .
maliang writing research repair-github-codebase-selection .
maliang writing evidence index .
maliang writing evidence search . --query "hierarchical planning" --limit 12
maliang writing evidence allocate .
maliang writing evidence consolidate .
maliang writing research verify . --max-sources 30
maliang writing research refresh .
```

`longwrite research refresh` preserves the old corpus under
`sources/archive/<timestamp>/`, refreshes provider recall, and writes
`reports/literature-refresh-delta.md` with the downstream stages to reopen.

The generated AutoResearch workflow executes indexing before outline and
allocation after outline approval. It then carries section packets through
drafting and makes the ledger part of final research validation. Review and
revision stages receive bounded `skills:` context from the relevant evidence
packets and ledger. MalaClaw expands these local globs deterministically and
caps injection at 24 documents / 180k characters; it never treats the entire
workspace as unbounded model context.

The quality-loop planner may select the declared targeted-expansion action
from its validated action plan. The selected action runs bounded provider
queries, refreshes metadata/full text/index/section packets, then hands the
revised packet set to the editor. It intentionally does nothing for the offline
`seed` provider, because recollecting its fixed corpus cannot repair coverage.

The workflow's enrichment stage attempts high-confidence Crossref title
matches for incomplete live-provider records, preserving the original source
URL while adding DOI, venue, citation-count, and open-access metadata. Its
post-loop verification stage checks only sources actually cited in chapters,
writes `sources/citation-verification.jsonl`, and follows redirects. Set
`source_policy.require_live_urls: true` only when unknown/dead links should
block final validation.

## Validation Boundary

Validation checks source IDs, bibliography consistency, section/taxonomy
coverage, and evidence locators. The review loop also includes `claim_judge`,
which emits sampled claim judgments (`entailed`, `partial`, or `unsupported`)
against the injected evidence packets. The deterministic `claim_score` stage
then enforces a 0.90 support-rate release target when judgments exist. This is
a review gate, not proof of scientific correctness or a substitute for human
academic review.

## Embeddings

`sqlite_fts` is the local, deterministic default. It is enough for offline
development and leaves no credential or embedding cost behind.

`hybrid_openai` is an opt-in OpenAI-compatible embedding adapter. It writes
`evidence/embeddings.jsonl` alongside the same chunk IDs and locators, then
uses reciprocal-rank fusion of FTS and vector rankings. Configure only the
backend/model in YAML and supply `MALACLAW_OPENAI_API_KEY` or
`OPENAI_API_KEY` in the environment; the key is never written to a workspace.
The index manifest records backend/model/chunk count so a run can be rebuilt
or audited. A missing key fails before indexing instead of silently falling
back to a different retrieval method.
