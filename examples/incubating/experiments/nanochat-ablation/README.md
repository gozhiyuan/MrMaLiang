# Nanochat Ablation Blueprint

This is incubating protocol material, not a public flagship. Read the
[development runbook](../../../../docs/incubating/experiments/nanochat-ablation.md) before
allocating GPU time. The checked-in config deliberately requires an explicit
candidate revision; it will not invent one.

```bash
maliang init nanochat-study --template experiment.nanochat-ablation
# Edit nanochat-study/experiment/experiment.yaml:
# pin Nanochat/data inputs, declare the candidate revision, and configure runner.

maliang preflight nanochat-study
maliang run nanochat-study --runtime script
```

Set `LONGEXPERIMENT_NANOCHAT_COMMAND` to a reviewed, pinned Nanochat launcher.
Begin with one seed and a small `LONGEXPERIMENT_NANOCHAT_MAX_ITERS` value only
when that launcher honors it; audit the result before restoring the declared
multi-seed pilot.
