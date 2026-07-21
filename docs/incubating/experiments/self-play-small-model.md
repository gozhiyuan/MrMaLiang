# Incubating: Small-Model Self-Play Validation

The matching versioned starting point is the
[self-play protocol](../../../examples/incubating/experiments/self-play-small-model/).

This suite implements the empirical shape of the AutoResearch self-play study
at pilot scale: inference comparison, exact simulation, training noise sweep,
held-out evaluation, and optional predeclared horizon/KL follow-ups. It does
not assert the survey's theory or reproduce its 285B resource scale.

Start from [`self_play_small_model.yaml`](../../packages/longexperiment/configs/flagships/self_play_small_model.yaml). Set
`LONGEXPERIMENT_SELF_PLAY_COMMAND` to a reviewed executor that emits one
terminal JSON metric per seed/condition; the bundled wrapper normalizes it into
per-study records. Review `reports/experiment-design.md`, then approve and run
through MalaClaw. LongExperiment—not the executor—computes paired comparisons
and publication eligibility. Only the resulting checksummed suite manifest may
be imported into LongWrite.

## Operator setup

Before any GPU allocation, implement and review the external executor named by
`LONGEXPERIMENT_SELF_PLAY_COMMAND`. For every supplied study, condition, and
seed it must end its standard output with exactly one JSON object:

```json
{"metric": 0.71, "artifacts": ["artifacts/evaluator-report.json"]}
```

The executor must pin the Qwen revision, fixed prompts, verifier-noise policy,
evaluator version, and heldout split; it must not merely report a training log
or a model-generated score. First run one condition/seed against a no-GPU or
short-GPU fixture, then a two-GPU-hour smoke job. A first real pilot should be
authorized independently (for example 24 L40S GPU-hours, plus any external
model/API costs) only after the smoke audit passes. Modal is optional; if used,
configure the remote-job adapter described in
[Remote GPU with Modal](../remote-gpu-modal.md).
