# LongExperiment Architecture

LongExperiment is a product layer for scientific or computational work. It is
not a new agent framework and it is not part of LongWrite. It converts an
experiment brief into a durable MalaClaw workflow, then normalizes results for
downstream writing.

```text
experiment.yaml + experiment_brief.md
                 |
                 v
       LongExperiment compiler
                 |
                 v
            malaclaw.yaml
                 |
                 v
    MalaClaw flow engine and supervisor
       |        |             |
       |        |             +-- quotas, retries, approvals, checkpoints
       |        +-- command runner / API worker / CLI harness
       |
       +-- dependency-ordered study fan-out (bounded parallelism)
       |        +-- command / AutoScientists / remote-job adapter
       |
       +-- external AutoScientists runner (optional, opaque)
                 |
                 v
results/studies/<id>/raw-results.json + per-study audits
                 |
                 v
aggregate paired comparisons + immutable manifest
                 |
                 +-- LongWrite tables, figures, and evidence inputs
```

## Ownership

- **MalaClaw**: process execution, DAG/loop orchestration, approvals, retry,
  quota pause/resume, event telemetry, and runtime selection.
- **LongExperiment**: hypotheses, trial budget, result contract, provenance,
  experiment-specific validation, and result reporting.
- **LongWrite**: literature, manuscript drafting, citation validation, and
  publication artifacts. It consumes an immutable experiment manifest rather
  than controlling an experiment runner.

`computational_experiment` now composes profiles (`existing_code`,
`public_benchmark`, and `from_scratch`), reusable study kinds, and declared suites. A suite may
link inference, simulation, training, held-out, horizon, and ablation studies
without forking the workflow. Optional follow-ups are allowlisted, bounded, and
audited; they are never free-form GPU requests.

Agentic authoring adds a pre-suite graph: bounded scholarly recall, proposal
schema/source validation, design approval, declarative candidate materialization,
human review before generated-code execution, compile/tests, one-seed smoke,
and a separate full-trial approval. Full trials then use the same deterministic
study audit and aggregation as prescribed runners. Generated code runs on the
worker host and is not made safe merely by workspace path checks; production
use requires a dedicated worker/container and explicit human review.

Remote execution uses MalaClaw's provider-neutral `remote-job` runtime. The
adapter persists an opaque job handle and invocation in flow state, supports
`submit` → `status` → `collect`, and receives a provider-side `cancel` request
when an operator stops a pending run. Credentials remain outside the workspace
and publication artifacts.

The current agentic empirical flagships do not yet route their generated
entrypoint through this remote-job adapter; they execute on the local worker.
Switching a config's runner kind is therefore not a supported shortcut to Modal.
