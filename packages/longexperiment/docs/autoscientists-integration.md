# AutoScientists Integration Boundary

AutoScientists is a separate research system with task-specific workflows and
its own internal agent organization. LongExperiment should **not** vendor or
attempt to reimplement that graph. Instead, it treats an installed checkout as
an external runner and captures its selected outputs through a stable contract.

## What is reused

1. A user installs and configures AutoScientists according to its upstream
   documentation.
2. `experiment.yaml` records the checkout, task, and explicit launch command.
3. MalaClaw runs that command as one durable work unit with normal budgets,
   logs, retries, and human approval gates.
4. A LongExperiment audit normalizes the chosen output into
   `results/experiment-manifest.json`.

## What is not reused

- AutoScientists' internal subagent scheduling or chat state.
- Its task implementations, datasets, credentials, or benchmark assumptions.
- Any claim that a successful runner process proves a scientifically valid
  result. The audit must check metrics, seed/trial provenance, and artifact
  paths.

## Configuration

```yaml
runner:
  kind: autoscientists
  repo_path: ../AutoScientists
  task: task-protein-gym
  launch_command: >
    cd ../AutoScientists && claude -p
    "Read runbook.md and execute. Task: task-protein-gym. Run name: longexperiment-protein-bench."
```

The launch command is intentionally explicit. It follows the upstream
Claude-Code/runbook launch shape while preventing the adapter from guessing
task-specific flags, and it keeps upgrades or forks reproducible.

## Canonical result hand-off

Every runner, including AutoScientists, should generate an audited manifest:

```json
{
  "version": 1,
  "project_id": "protein-bench",
  "hypothesis": "...",
  "status": "completed",
  "metrics": { "spearman": 0.42 },
  "artifacts": {
    "results_json": "results/raw-results.json",
    "tables": ["artifacts/table-01.csv"],
    "figures": ["artifacts/figure-01.png"],
    "logs": ["logs/runner.log"]
  },
  "provenance": {
    "runner_kind": "autoscientists",
    "generated_at": "2026-07-11T00:00:00.000Z"
  }
}
```

LongWrite may cite the result only after this manifest and its audit pass.
