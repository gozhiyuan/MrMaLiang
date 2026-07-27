# Flagship Blueprints

Each folder is a small, versioned starting point for one documented flagship.
It contains a declarative `blueprint.yaml` and a short operator README. Create
the actual workspace with `maliang init`; do not copy a completed workspace
into this repository.

Completed runs may contain PDFs, full text, evidence chunks, SQLite indexes,
remote-job records, and provider-specific logs. Keep those outside Git and use
their `reports/run-provenance.json` plus output checksums as the durable link to
the exact blueprint and MrMaLiang revision that produced them.

| Blueprint | Template | Canonical runbook |
| --- | --- | --- |
| [Long agentic survey](./long-agentic-survey/) | `paper.survey` | [Runbook](../../docs/flagships/long-agentic-survey.md) |
| [Repository survey](./repository-survey/) | `paper.survey` + repository | [Runbook](../../docs/flagships/repository-survey.md) |
| [Nanochat agentic empirical paper](./nanochat-agentic-empirical-paper/) | `paper.empirical` + repository | [Runbook](../../docs/flagships/nanochat-agentic-empirical-paper.md) |
| [Self-play autonomous empirical paper](./self-play-autonomous-empirical-paper/) | `paper.empirical` | [Runbook](../../docs/flagships/self-play-autonomous-empirical-paper.md) |

`maliang init <workspace> --blueprint <id>` reads `blueprint.yaml`, selects its
declared template, and creates the executable component configuration under
`writing/` or `experiment/`. The Markdown is explanation only. The checked-in
`workspace/` folder is the golden, resolved configuration snapshot that tests
the generated workspace contract; it is not copied as an opaque directory.

See [flagship platform adoption](../../docs/flagships/platform-adoption.md)
before changing a blueprint's template, runner, or authorization model. The
two empirical-paper flagships use generalized Modal remote-job profiles and
require a reviewed adapter plus a config-bound authorization lease before a
run; their scaffolded adapter intentionally fails closed until configured.
