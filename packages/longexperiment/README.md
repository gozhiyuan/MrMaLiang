# LongExperiment

> MrMaLiang component — operators use the unified `maliang` CLI at the
> repository root. The package CLI is an internal stage/compatibility interface,
> not a second public workflow surface.

LongExperiment is an open, inspectable product layer for long-running
computational experiment workflows on [MalaClaw](../MalaClaw). It owns the
experiment brief, design approval, runner configuration, result provenance,
and a stable hand-off contract for LongWrite. MalaClaw owns execution,
retries, quotas, approvals, state, and telemetry.

It remains a separate component from LongWrite: a paper can consume an audited
experiment result, but a writing workflow does not need to control a benchmark
or a training job. MrMaLiang coordinates their verified handoff for empirical
paper templates without making either component mandatory for the other.

## Current scope

The `computational_experiment` mode supports two authoring contracts.
Prescribed protocols compile this checked flow:

```text
hypothesis -> design approval -> immutable input locks -> isolated worktrees
           -> dependency-level study fan-out -> per-study audit
           -> deterministic paired aggregation -> provenance audit -> report
```

It is an execution and evidence contract, not a claim of autonomous scientific
discovery. A runner writes one `results/studies/<study>/raw-results.json` per
study. LongExperiment verifies condition/seed coverage, immutable input pins,
existing artifacts and checksums, then computes paired comparisons itself.
Only that audited aggregate can become `results/experiment-manifest.json`.

Agentic protocols add literature-grounded proposal validation and a bounded
code-authoring loop before the same frozen suite and audit:

```text
pins -> literature context -> proposal/validation -> design approval
     -> candidate bundle -> human code approval -> tests -> one-seed smoke
     -> full-trial approval -> frozen trials -> audit/statistics -> handoff
```

The candidate may not alter the configured metric, direction, controls, seeds,
condition names, pins, or budget. Every generated revision requires review
before execution. Path confinement is not an OS sandbox; use a dedicated worker
or container without unrelated credentials or data.

Profiles (`existing_code`, `public_benchmark`, `from_scratch`) and suite configs compose with
this shared flow. The three full examples are the small-model self-play,
nanoGPT ablation, and ProteinGym/AutoScientists-compatible prescribed suites,
plus the two public agentic empirical configurations in
[`configs/flagships/`](configs/flagships/). The prescribed suites remain
incubating examples; the public paper flagships are documented in the root hub.

## Quick Start

Requires Node.js 22+ and a working `malaclaw` CLI.

```bash
npm install
npm run build

maliang init memory-ablation \
  --template experiment.standalone \
  --hypothesis "Memory retrieval improves long-horizon planning."

# Review experiment/experiment.yaml and configure its prescribed runner.
maliang experiment sync memory-ablation
maliang preflight memory-ablation --runtime script
maliang run memory-ablation --runtime script
```

The design gate pauses before execution by default. Inspect
`reports/experiment-design.md`, approve it, then resume the flow. Do not run a
command you have not reviewed.

For a remote run, configure a Modal `adapter_command` that implements the
MalaClaw JSON lifecycle protocol: `submit`, `status`, `collect`, and `cancel`.
MalaClaw persists its job handle, polls it after a restart, collects declared
artifacts before validation, and sends provider-side cancellation when the
operator cancels a paused job.

Modal is not required: a reviewed local or other-provider command runner is
also valid. If Modal is selected, use the complete
[MrMaLiang remote-GPU setup guide](../../docs/remote-gpu-modal.md) before
authorizing compute; the checked-in flagships do not contain credentials or a
generic detached-CLI shortcut.

## AutoScientists

An AutoScientists checkout can be used as an **external runner**. LongExperiment
does not copy or orchestrate its internal subagents; it records a specific
launch command and audits the artifacts it produces. See
[the integration design](docs/autoscientists-integration.md).

```bash
maliang init protein-bench \
  --template experiment.proteingym-autoscientists
```

Add `runner.launch_command` to `experiment/experiment.yaml`, then run
`maliang experiment sync protein-bench` before execution. The deliberate safe
default fails rather than guessing the upstream command.

## Design

- [Architecture](docs/architecture.md)
- [AutoScientists integration boundary](docs/autoscientists-integration.md)
- [Flagship experiment suites](../../docs/flagships/README.md)

Upstream references: [AutoScientists repository](https://github.com/mims-harvard/AutoScientists)
and [paper](https://arxiv.org/abs/2605.28655).
