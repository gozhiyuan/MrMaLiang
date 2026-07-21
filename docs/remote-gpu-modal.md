# Remote GPU with Modal

Modal is optional. Literature and repository surveys do not need it, and every
LongExperiment suite may instead use a reviewed local or other-provider
executor. Use Modal when the approved runner genuinely needs a remote GPU.

The current nanoGPT and self-play **agentic empirical-paper** blueprints execute
their generated Python entrypoint on the MalaClaw worker host. Changing their
`runner.kind` does not transparently remote generated code. The adapter below is
for prescribed-runner suites until an agentic candidate submit/collect contract
is implemented and tested. Follow each agentic runbook and use a dedicated
local worker/container for those release candidates.

## Account and authentication

1. Create a Modal account and install its Python package/CLI:

   ```bash
   python -m pip install modal
   modal setup
   modal token info
   ```

2. For unattended execution, create a service-user token and provide
   `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` only through the launcher
   environment or a secrets manager. Never put either value in a workspace,
   YAML config, paper, archive, or Git history.

3. Start with a separate development environment/profile. Confirm a harmless
   Modal job works before connecting it to MalaClaw.

Modal's current onboarding and token instructions are authoritative:
[getting started](https://modal.com/docs/guide),
[token commands](https://modal.com/docs/cli/latest/token), and
[service users](https://modal.com/docs/guide/service-users).

## MrMaLiang adapter contract

LongExperiment does not invoke `modal run --detach` directly. A workspace-owned
adapter is required so MalaClaw can durably submit, poll, collect, and cancel
the same remote job after restart:

```yaml
runner:
  kind: modal
  app_path: adapters/modal_runner.py
  function_ref: experiment.run_study
  gpu: A10
  max_gpu_hours: 12
  environment: development
  adapter_command: python3 adapters/modal_adapter.py
```

The adapter receives the JSON lifecycle request on standard input and must
implement `submit`, `status`, `collect`, and `cancel`. `collect` may write a
study's `raw-results.json` only after every declared artifact is present.
Before an experiment run, validate the adapter with a no-GPU fixture and a
single-seed smoke job. Do not convert a command-runner flagship to Modal until
its adapter and container image have been reviewed.

## Cost controls

`max_gpu_hours` is an authorization cap, not a forecast. Keep it consistent
with `execution.max_parallel_trials` and `execution.max_active_run_minutes`,
and make the reviewed adapter pass that cap to the provider-side job. Stop on
the first failed smoke run, inspect the remote job, then resume only with
approval.

At the time this guide was updated, Modal lists these GPU-only rates:

| GPU | Rate/hour | 12 GPU-hour cap | 24 GPU-hour cap |
| --- | ---: | ---: | ---: |
| A10 | $1.10 | $13.22 | $26.44 |
| L40S | $1.95 | $23.41 | $46.83 |
| A100 80 GB | $2.50 | $29.98 | $59.96 |
| H100 | $3.95 | $47.39 | $94.78 |

These figures exclude CPU, memory, storage, egress, model/API charges, and
any external AutoScientists costs. Modal's live price page—not this table—is
the source of truth: [Modal pricing](https://modal.com/pricing).

For the incubating prescribed-runner protocols, recommended initial
authorization caps are deliberately modest:

| Flagship | First smoke | First real pilot | Do not approve until |
| --- | ---: | ---: | --- |
| nanoGPT | 1 A10 GPU-hour / $2 | 12 A10 GPU-hours / $20 | baseline and candidate revision are pinned |
| Small-model self-play | 2 L40S GPU-hours / $5 | 24 L40S GPU-hours / $75 | executor, prompts, evaluator, and heldout split are reviewed |
| ProteinGym / AutoScientists | 2 L40S GPU-hours / $5 | 24 L40S GPU-hours / $75–150 | task launcher, benchmark access, and external-token costs are bounded |

The pilot numbers are spend authority, not expected scientific cost. A suite
may need a larger approved follow-up only after its smoke result and audit are
reviewed.
