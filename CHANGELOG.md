# Changelog

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
