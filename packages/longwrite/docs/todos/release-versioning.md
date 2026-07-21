# TODO: Cross-Repository Release Versioning

Status: defer until the LongWrite survey flagship and the LongExperiment
results-bundle integration are stable. Current source-checkout runs are
identified exactly by their provenance Git revisions.

## Release prerequisites

- Define and version the LongWrite ↔ LongExperiment verified results-bundle
  schema. LongExperiment must not depend on LongWrite; LongWrite consumes an
  audited bundle only for `paper_kind: empirical`.
- Define MalaClaw application compatibility ranges for LongWrite and
  LongExperiment, and add CI coverage for every supported tuple.
- Make each application emit its package version and Git revision into the
  shared run-provenance shape. Preserve the runtime, model policy, provider,
  configuration hash, corpus/results hash, and output checksums.
- Require an explicit model identifier for any public example that claims a
  specific LLM; an unpinned harness default must remain visibly unresolved.
- Decide package distribution (GitHub Releases first; registry publication only
  when external installation needs it) and document upgrade/reproduce flows.

## First coordinated prerelease

After the prerequisites pass, publish immutable annotated prerelease tags and
release notes for the three independently deployable applications:

```text
MalaClaw        v0.x.y
LongWrite       v0.x.y (requires MalaClaw ^0.x.y)
LongExperiment  v0.x.y (requires MalaClaw ^0.x.y; exports results-bundle v1)
```

LongWrite should declare LongExperiment as optional: a survey must run without
it, while an empirical paper stops at a preregistration/handoff artifact until
a compatible verified results bundle is supplied.

## Example policy

Use small Git-tracked recipe workspaces. Publish final PDFs and large archival
bundles as release assets, with URLs and SHA-256 checksums recorded in each
example's provenance. Do not create a mandatory fourth workspace repository
unless a curated public gallery later needs its own release cadence.
