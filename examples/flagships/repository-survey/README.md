# Repository Survey Blueprint

The full guide is [here](../../../docs/flagships/repository-survey.md). Replace
the sample repository with a Git URL, a local Git directory, or both.

```bash
maliang init repo-study \
  --blueprint repository-survey \
  --repository https://github.com/your-org/your-repository.git

maliang preflight repo-study --runtime codex
maliang run repo-study --runtime codex
```

The generated workspace resolves the repository to an immutable commit before
the paper may cite code evidence. Its full expected writing config is in
`workspace/writing/longwrite.yaml`; the repository fields are dynamically set.

For a discovery-driven variant, omit `--blueprint`/`--repository` and use
`--template paper.survey --discover-repositories` with explicit discovery
budgets as documented in the full guide.
