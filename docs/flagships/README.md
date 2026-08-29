# MrMaLiang Flagship Runs

This is the canonical operator-facing runbook hub. Each runbook uses the public
`maliang` CLI and creates a parent research-program workspace. Component CLIs
and generated MalaClaw stage commands are implementation details.

## Public flagship runbooks

| Runbook | Preset | Start only after |
| --- | --- | --- |
| [Short survey](./paper-flagship-presets.md#short-survey) | `flagship_short_paper` | Topic and scope are set. |
| [Long survey](./long-agentic-survey.md) | `flagship_long_paper` | The [blueprint](../../examples/flagships/long-agentic-survey/) seed/dry-run rehearsal passes. |
| [Short GitHub paper](./paper-flagship-presets.md#short-github-paper) | `flagship_short_github_paper` | Topic, scope, and repository are set. |
| [Long GitHub paper](./repository-survey.md) | `flagship_long_github_paper` | The [blueprint](../../examples/flagships/repository-survey/) repository and revision are chosen. |
| [Nanochat agentic empirical paper](./nanochat-agentic-empirical-paper.md) | empirical | Dedicated worker, design/code approvals, local smoke, and compute review pass. |
| [Self-play autonomous empirical paper](./self-play-autonomous-empirical-paper.md) | empirical | Dedicated worker, model/benchmark access, design/code approvals, local smoke, and compute review pass. |

Start with the short survey, then the long survey or a GitHub paper, then the Nanochat pilot. The
survey workflows are validated writing flagships. The two empirical workflows
are executable release candidates: their agentic graphs, approval gates,
statistics, handoff, and configurations are tested, but this repository does not
claim scientific results before a real controlled run passes all gates.

Read the shared [preflight contract](../flagship-preflight.md) and, only when
using a remote GPU provider, [Modal setup and spend controls](../remote-gpu-modal.md).
The [blueprint directory](../../examples/flagships/) holds the corresponding
versioned starting configuration for every release-ready runbook.
