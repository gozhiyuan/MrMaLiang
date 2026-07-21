# Small-Model Self-Play Blueprint

This is incubating protocol material, not a public flagship. Read the
[development runbook](../../../../docs/incubating/experiments/self-play-small-model.md). This
is a pilot-scale empirical suite, not a reproduction of a 285B-scale study.

```bash
maliang init self-play-study --template experiment.self-play-small-model
# Set LONGEXPERIMENT_SELF_PLAY_COMMAND and review experiment/experiment.yaml.

maliang preflight self-play-study
maliang run self-play-study --runtime script
```

The executor must emit one normalized terminal JSON metric/artifact object per
declared seed and condition. Run a one-condition, one-seed smoke first.
