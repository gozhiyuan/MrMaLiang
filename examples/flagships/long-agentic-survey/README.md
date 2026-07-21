# Long Agentic Survey Blueprint

The full guide is [here](../../../docs/flagships/long-agentic-survey.md).
This blueprint targets a 24,000-word manuscript, typically suitable for a
60+ page PDF depending on layout, tables, and figures.

```bash
maliang init llm-memory-agentic --blueprint long-agentic-survey

maliang preflight llm-memory-agentic --runtime codex
maliang run llm-memory-agentic --runtime codex
```

Run the seed/dry-run rehearsal in the full guide first. Configure optional
provider keys only in `llm-memory-agentic/writing/.env`. The full resolved
config expected from this command is in `workspace/writing/longwrite.yaml`.
