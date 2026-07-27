# Changelog

## 0.3.0 — 2026-07-26

### Requires

- **MalaClaw >= 1.1.0.** Compiled manifests depend on the foreach
  command-template fix; on 1.0.2 every study execution receives a literal
  `{{item.id}}` and fails. `runtime-compatibility.json` raises the floor.

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
