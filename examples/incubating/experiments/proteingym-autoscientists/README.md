# ProteinGym / AutoScientists Blueprint

This is incubating protocol material, not a public flagship. Read the
[development runbook](../../../../docs/incubating/experiments/proteingym-autoscientists.md).
LongExperiment audits the resulting trials, but it does not control or replace
AutoScientists’ internal agents.

```bash
maliang init proteingym-study --template experiment.proteingym-autoscientists
# Set LONGEXPERIMENT_AUTOSCIENTISTS_COMMAND and review experiment/experiment.yaml.

maliang preflight proteingym-study
maliang run proteingym-study --runtime script
```

Confirm licenses, benchmark access, the heldout assay split, and non-GPU model
or API costs before approving more than the one-assay, one-seed smoke run.
