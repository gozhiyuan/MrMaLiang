# LongWrite

LongWrite is MrMaLiang’s writing component. It builds source-grounded surveys,
repository studies, empirical-paper manuscripts, technical books, and novels.
It owns the research evidence ledger, manuscript renderer, citation checking,
and release gates.

## Operator interface

Use the `maliang` command from the monorepo root. `longwrite` is an internal
component CLI invoked by MrMaLiang and by generated MalaClaw stages; it is not
an operator-facing installation or documentation target.

```bash
# Install the one public CLI from a source checkout.
npm install
npm run build
npm link --workspace @mr-maliang/maliang

# Inspect the supported templates.
maliang template list

# Create a long survey program. Options after -- customize LongWrite.
maliang init agent-memory-survey \
  --template paper.survey \
  --topic "Long-horizon memory and planning in LLM agents" \
  -- \
  --research-provider multi \
  --research-workflow-profile deep \
  --target-length-words 24000 \
  --citation-style author_year

# Run and inspect the parent research-program workspace.
maliang preflight agent-memory-survey --runtime codex
maliang run agent-memory-survey --runtime codex
maliang status agent-memory-survey

# Use an allowlisted writing operation when inspecting a component artifact.
maliang writing metrics words agent-memory-survey
maliang writing report packet agent-memory-survey
```

The parent workspace contains `maliang.yaml`, `writing/`, and, for empirical
templates, `experiment/`. The public CLI rewrites the parent workspace argument
to the correct component directory; do not invoke or install a global
`longwrite` binary.

## Documentation

- [Quickstart](./docs/quickstart.md)
- [Flagship runbook hub](../../docs/flagships/README.md)
- [Full AutoResearch Agentic Survey Flagship](../../docs/flagships/long-agentic-survey.md)
- [Repository Study Paper Flagship](../../docs/flagships/repository-survey.md)
- [Configuration reference](./docs/configuration.md)
- [Research and evidence contract](./docs/research-evidence.md)
- [Retention, archive, and prune lifecycle](./docs/workspace-lifecycle.md)
- [Architecture](./docs/architecture.md)

## Component boundaries

LongWrite accepts a validated LongExperiment manifest for empirical work, but
does not execute experiments itself. MrMaLiang coordinates that handoff through
`maliang run` and `maliang handoff import`, preserving source revisions,
checksums, result evidence packets, and figure/table provenance.

MalaClaw remains a separate runtime/orchestrator. Generated flows call the
private component entry points so that resume state, retry behavior, and
artifact contracts stay local to the component. Operators use `malaclaw` only
for runtime inspection or advanced flow operations, for example:

```bash
malaclaw flow runtimes
```

## Development

The component is an npm workspace package. Build and test the whole monorepo
after changing shared contracts:

```bash
npm run build
npm test
npm run release:check
```

The component’s TypeScript source lives in `src/`; its CLI compatibility entry
point exists only for generated workflow stages and integration tests.
