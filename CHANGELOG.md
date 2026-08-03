# Changelog

## 0.3.2 — 2026-08-03

Defaults that had drifted from the workspaces actually being run, found by
diffing a live flagship workspace against a freshly generated one.

### Fixed

- **The Nano Banana default model was a version behind.** It defaulted to
  `gemini-2.5-flash-image` while a live flagship pinned
  `gemini-3.1-flash-image` by hand.
- **The image backend was invisible in generated workspaces.** The scaffold
  emitted no `figures.backends` block at all, so the only paid backend could
  not be found without reading the schema. It is now emitted
  `enabled: false, requires_approval: true` — discoverable, and still never on
  by default.
- **A last artifact quota survived in the scaffold.** A non-agentic mode with a
  `deep` workflow profile would have received `min_figures: 3, min_tables: 5,
  min_comparative_tables: 1, min_verified_metadata_plots: 2`. No such mode
  exists today, so the branch was unreachable, but it would have handed the
  next one a count target the rest of the design had already rejected.

### Note for existing workspaces

A workspace generated before 0.3.0 keeps its own `longwrite.yaml` **and** its
compiled `malaclaw.yaml`. The manifest is where the artifact-planner
instructions live, so a stale one still tells the planner to treat quality
targets as an artifact budget even after the config is correct. Re-sync before
the next run:

```bash
maliang writing sync .
maliang writing validate config .
```

## 0.3.1 — 2026-08-03

Finishes what 0.3.0 started. That release moved artifact selection from a
quota to the agent's judgement, but three places still had the renderer
deciding what a paper contained.

### Fixed

- **`repository_study` still carried the quota.** 0.3.0 zeroed the count gates
  for `literature_survey` only, leaving repository studies required to produce
  3 figures, 3 tables, 1 comparative table, and 1 metadata plot. Its counts are
  now zero too. The architecture diagram stays required by id: that is a domain
  requirement of a paper about a system, not a count target.
- **A fixed table menu survived as dead code.** `table_overrides` was still
  bound to `z.enum(["method-comparison", "benchmark-metadata"])` — two built-in
  tables 0.3.0 stopped generating — and the path was never read, so an override
  was parsed, source-id validated, then silently discarded. Removed;
  `table_specs` is the source-bound way to declare a table.
- **Unfulfilled placements failed silently.** A placement naming an artifact
  that no longer exists was dropped with no signal, so a planner asking for a
  retired built-in could not tell its request had been ignored. Unfulfilled
  placements are now listed in `reports/visual-plan-repair.md`, distinguishing
  an id that selects nothing from a renderer or backend that did not run.
- **A canned rationale satisfied the insight gate.** `require_insight_statements`
  exists to make the planner say why an artifact earns its space, but built-in
  figures arrived with an insight the renderer had written — the same defect as
  a quota, a gate satisfiable without the evidence it demands. The renderer may
  now label an artifact factually and may not argue for it: `concept_map` takes
  an optional `insight`, verified metadata plots take framing from a new
  `metadata_plots` spec, and an artifact without one fails the gate rather than
  borrowing a sentence.

`concept_map.insight` is optional so an existing placement plan still parses.
Such a plan now fails the insight gate instead of breaking the build — add an
insight, or drop the artifact.

## 0.3.0 — 2026-08-03

### Requires

- **MalaClaw >= 2.0.0.** Compiled manifests use the durable-flow-only contract.
  `runtime-compatibility.json` raises the floor; older runtimes are rejected
  before a run can execute under an incompatible manifest schema.

### Added

- Generalized research loop (`research:` policy): a bounded
  propose -> validate -> materialize -> implement -> verify -> execute -> audit
  -> promote search, opt-in per workspace so existing pipelines are untouched.
- Deterministic round machinery: lineage, promotion, dead-end memory, round
  archiving, and research state, all with atomic writes.
- `implement` and `verify` candidate steps. `verify` enforces the mutation
  policy, rejects an empty diff, and commits each candidate as an immutable
  commit bound into lineage.
- Reusable LongWrite workflow modules for the eight domain fragments.
- MrMaLiang dashboard extension: research overview, evidence, manuscript, and
  release pages, served from one normalized server projection.
- `npm run smoke:execution` — scaffolds workspaces, validates each through the
  engine, and executes a prescribed experiment. Wired into CI.
- `--keep-workspace` on the Modal smoke so a real GPU rehearsal leaves durable,
  auditable artifacts instead of deleting them.

### Fixed

- **Compiled manifests were invalid.** Prescribed workspaces emitted the worker
  runtime `script` into the manifest-level `runtime` (the provisioning enum),
  and the agentic search-plan stage declared `../writing/project_brief.md`,
  which escapes the workspace. Both failed `malaclaw validate` while the golden
  suites stayed green, because they compared compiled output against itself.
  Goldens now also parse through the engine's schema.
- **The `fast` workflow profile produced an invalid workflow.** It disables
  `structure_audit` while the outline loop still required that stage's outputs.
- **Python/TypeScript statistical parity was interpreter-dependent.** CPython
  3.12+ gives `sum()` compensated summation, so a bootstrap bound differed from
  the TypeScript auditor. The Python helper now mirrors TypeScript exactly.
- Seed-mode packaging wrote no submission manifest at all; it now writes one
  flagged `release_ready: false` with the blocking findings.

### Changed

- LongExperiment and LongWrite build stages through `malaclaw/sdk` builders.
  Emitted IR is unchanged; golden parity is proven per increment.
- **A paper artifact is selected for an argument, not to fill a quota.** The
  `literature_survey` profile required 6 figures and 12 tables and named five
  mandatory visual ids, so a run with nothing to compare still had to publish
  something — and what it published was corpus bookkeeping (citation-depth
  distributions, venue inventories, packet-status columns, source-title
  listings) presented as analysis. Nothing is published now unless the artifact
  plan selects it. The surviving gates measure relevance rather than volume:
  source binding, a required insight statement, and a rendered-visual review
  that treats pipeline telemetry as a major finding. `table_specs.kind` is a
  free descriptive label instead of a three-value menu, and diagrams are a
  first-class declarative spec, so an agent can choose the form its argument
  needs. Run counters and provenance disclosure now default off — they are
  operator telemetry and belong in `reports/`.
  **Breaking:** an existing workspace keeps its own configured gates; run
  `maliang writing sync .` to adopt the new defaults.
- `maliang run --reset` resets component flow state before running, instead of
  requiring the component CLI in the right subdirectory.

### Fixed (agentic research pipeline)

- **The outline review loop never assessed its last revision.** It ran
  review → score → revise, so `max_rounds` counted revisions, some of them
  unverified. The flow now audits and reviews the initial outline first, and
  each repair attempt is followed by fresh audits, an evidence-grounded
  critique, and a script-owned readiness score.
- **Recovery rounds destroyed validated evidence.** Each round overwrote
  `evidence/source-packets.json` with only its own packets, so a source
  validated in round one silently lost its A/B depth in round two and the
  corpus shrank as recovery ran. Validated evidence now accumulates in
  `evidence/validated-source-evidence.json`, and `finalize-evidence-depth`
  publishes the citation-ready set as
  `evidence/active-validated-source-evidence.json`, which the outline and
  reviewer read. `maliang writing research backfill-validated-evidence-history`
  and `… restore-recovery-corpus` rebuild both files for affected workspaces.
- **Taxonomy coverage required a verbatim label match.** A cell's
  human-readable label had to appear literally in a paper, which no real paper
  does. Coverage now matches on meaningful label terms from the title and
  abstract, excluding the query terms that retrieved the record — otherwise one
  broad search satisfies every cell.
- **Snowball capped its seeds before filtering them.** The cap could be
  consumed entirely by OpenAlex-only records, reporting an all-skip run against
  a corpus full of usable arXiv/S2 seeds. It now filters to
  citation-network-addressable records first and orders by LQS rather than raw
  citation count.
- **The dashboard reported a healthy corpus as zero sources.** The projection
  read `evidence/coverage.json` as if it held every source object; it holds a
  compact taxonomy summary. Counts and depth distributions now come from
  `sources/classified_sources.jsonl`, chapters from `outline.json` plus the
  on-disk drafts, and the PDF check looks for `build/manuscript.pdf`.
- **`maliang writing dashboard` found no project from the workspace root.** It
  launched MalaClaw from the current directory, but a program workspace owns
  `maliang.yaml` while `malaclaw.yaml` belongs to its `writing/` component. The
  launcher resolves the component first.
- A venue containing a comma (`arXiv:gr-qc,astro-ph.HE`) was declared as one
  pgfplots symbolic category and plotted as a different, truncated one.
- Building a manuscript whose only figure was a generated illustration crashed
  on a missing `paper/figures/` directory — previously unreachable, because the
  default artifacts guaranteed the directory existed.

## 0.2.0 — 2026-07-20

### Added

- `maliang` is the single public CLI for all writing and experiment templates.
- Allowlisted `maliang writing …` and `maliang experiment …` proxy namespaces
  with registry-derived help and parent-workspace path rewriting.
- Unified preflight report at `reports/maliang-preflight.json` and validated
  init customization passthrough after `maliang init … --`.
- Public CLI documentation linting plus integration coverage for child exit and
  signal propagation.

### Changed

- New workspaces always use `writing/` and/or `experiment/` beneath a parent
  MrMaLiang workspace; legacy component-workspace adoption is not supported.
- Operator guides now use `maliang`; component CLIs remain internal to
  generated MalaClaw stages and package development.
- LongWrite initialization supports explicit `--citation-style numeric|author_year`.

### Fixed

- Unified preflight now removes stale derived component reports before each
  invocation, validates report shape, and fails closed on crashes or an
  inconsistent passing report.
- Proxy routing rejects unavailable experiment commands and emits actionable
  errors when a component build or MrMaLiang workspace is absent.
