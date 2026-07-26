# Flagship Platform Adoption

The flagship blueprints are versioned, reproducible entry points. Their
`template:` field is authoritative; operators should keep using
`maliang init <workspace> --blueprint <id>` rather than replacing a flagship
with a loosely equivalent template command.

| Flagship | Current public template | Execution status |
| --- | --- | --- |
| Long agentic survey | `paper.survey` | Current LongWrite/MalaClaw workflow; no experiment component or GPU required. |
| Repository survey | `paper.survey` plus `--repository` | Current LongWrite/MalaClaw workflow; the repository is pinned software evidence and is never executed. |
| Nanochat agentic empirical paper | `paper.empirical` | Generalized `repository_optimization` pilot; candidate tests, smoke, and studies use the Modal remote-job contract. |
| Self-play autonomous empirical paper | `paper.empirical` | Generalized `survey_pilot_study` pilot; candidate tests, smoke, and studies use the Modal remote-job contract. |

`paper.survey` and `paper.empirical` are parameterized public contracts, not
new names for individual flagships. The blueprints supply the pinned inputs,
research targets, and runbook-specific defaults that a bare template cannot
infer.

## Generalized LongExperiment profiles

The generalized LongExperiment kernel defines three profiles:
`repository_optimization`, `survey_pilot_study`, and `paper_reproduction`.
They add authorization leases, lineage, proposal/dead-end records, and
provider-neutral remote-job handles. The two agentic empirical-paper blueprints
now use the first two profiles; paper reproduction remains an incubating
standalone profile.

For the migrated empirical flagships, candidate tests, the one-seed smoke
comparison, and full studies are separate `remote-job` phases. The control
plane may validate and materialize a candidate bundle, but it never executes
that generated code locally. A config-bound lease is checked before the flow
can author a candidate or submit remote compute.

Each new workspace includes a reviewed, workspace-owned Modal Sandbox adapter
at `experiment/templates/adapters/modal/agentic_adapter.py`, together with its
locked `uv` environment. It implements submit, status, logs, collect, and
cancel for all three phases. It creates a separate Sandbox and Volume for each
remote unit, persists the combined provider handle through MalaClaw, and copies
only declared artifacts back after successful completion. Results remain pilot
evidence until the complete experiment and manuscript release gates pass.

## Operator decision

1. Use the survey blueprints for literature or repository evidence; no
   LongExperiment authorization is involved.
2. Use the empirical blueprints only after configuring and smoke-testing their
   remote adapter, then issue a bounded lease. Keep design, candidate, and
   full-trial approvals enabled unless a separately approved policy changes
   them.
3. Use the paper-reproduction profile only for a bounded engineering pilot,
   with its own pinned config, authorization lease, and remote adapter smoke
   test. Do not route its result into a paper until the audited handoff passes.

This policy keeps template selection, execution isolation, and publication
claims aligned with what the implementation actually enforces.
