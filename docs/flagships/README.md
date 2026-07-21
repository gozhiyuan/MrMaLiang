# MrMaLiang Flagship Runs

This is the canonical operator-facing runbook hub. Each runbook uses the public
`maliang` CLI and creates a parent research-program workspace. Component CLIs
and generated MalaClaw stage commands are implementation details.

## Public flagship runbooks

| Runbook | Template | Mode axes | Start only after |
| --- | --- | --- | --- |
| [Long agentic survey](./long-agentic-survey.md) | `paper.survey` | survey · literature · none | The [blueprint](../../examples/flagships/long-agentic-survey/) seed/dry-run rehearsal passes. |
| [Repository survey](./repository-survey.md) | `paper.survey` + repository | survey · repository · none | The [blueprint](../../examples/flagships/repository-survey/) repository and revision are chosen. |
| [nanoGPT agentic empirical paper](./nanogpt-agentic-empirical-paper.md) | `paper.empirical` + repository | empirical · repository · run · agentic | Dedicated worker, design/code approvals, local smoke, and compute review pass. |
| [Self-play autonomous empirical paper](./self-play-autonomous-empirical-paper.md) | `paper.empirical` | empirical · literature · run · agentic | Dedicated worker, model/benchmark access, design/code approvals, local smoke, and compute review pass. |

Start with the survey, then the repository survey, then the nanoGPT pilot. The
survey workflows are validated writing flagships. The two empirical workflows
are executable release candidates: their agentic graphs, approval gates,
statistics, handoff, and configurations are tested, but this repository does not
claim scientific results before a real controlled run passes all gates.

Read the shared [preflight contract](../flagship-preflight.md) and, only when
using a remote GPU provider, [Modal setup and spend controls](../remote-gpu-modal.md).
The [blueprint directory](../../examples/flagships/) holds the corresponding
versioned starting configuration for every release-ready runbook.
