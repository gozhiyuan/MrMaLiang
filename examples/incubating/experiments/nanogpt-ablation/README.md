# nanoGPT Ablation Blueprint

This is incubating protocol material, not a public flagship. Read the
[development runbook](../../../../docs/incubating/experiments/nanogpt-ablation.md) before
allocating GPU time. The checked-in config deliberately requires an explicit
candidate revision; it will not invent one.

```bash
maliang init nanogpt-study --template experiment.nanogpt-ablation
# Edit nanogpt-study/experiment/experiment.yaml:
# pin nanoGPT/data inputs, declare the candidate revision, and configure runner.

maliang preflight nanogpt-study
maliang run nanogpt-study --runtime script
```

Begin with one seed and a small `LONGEXPERIMENT_NANOGPT_MAX_ITERS` value, audit
the result, then restore the declared multi-seed pilot.
