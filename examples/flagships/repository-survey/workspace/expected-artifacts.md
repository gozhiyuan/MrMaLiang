# Expected Artifacts

The generated `writing/longwrite.yaml` matches this snapshot except for the
repository identifier, source URL, resolved Git revision, and workspace identity.
The resulting `writing/codebases/manifest.json` is the authoritative pin used
for code citations. The repository analysis stage then writes
`writing/evidence/codebase-analysis.raw.json`; the deterministic repair stage
accepts it only when every architecture statement uses an exact locator from
`writing/evidence/codebase-chunks.jsonl`, producing
`writing/evidence/codebase-analysis.json` and
`writing/reports/codebase-analysis-repair.md`. The comparison stage then writes
and validates `writing/evidence/codebase-comparison.json`. Software citation
metadata comes from `CITATION.cff` when present, and bounded unpinned README
mentions are recorded in `writing/codebases/mentioned-repositories.json` without
recursive fetching. Generated flow YAML remains
derived and is not tracked in the example.
