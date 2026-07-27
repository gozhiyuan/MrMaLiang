# Incubating: Nanochat Controlled Ablation

The matching versioned starting point is the
[Nanochat-ablation protocol](../../../examples/incubating/experiments/nanochat-ablation/).

This incubating protocol pins Nanochat, reproduces a baseline, and evaluates candidate
worktree revisions under a fixed data split, budget, and seed set. The primary
checkout is never edited. New candidate code pauses for review before remote
execution; parameter-only trials within an approved revision can run in the
declared batch budget.

Use [`nanochat_ablation.yaml`](../../packages/longexperiment/configs/flagships/nanochat_ablation.yaml).
Its runner is the bundled
[`nanochat.py`](../../packages/longexperiment/templates/runners/nanochat.py), which
requires an explicit reviewed `LONGEXPERIMENT_NANOCHAT_COMMAND` and normalized
metric record for every configured seed/condition. Set
`LONGEXPERIMENT_NANOCHAT_MAX_ITERS` only when that reviewed launcher honors it;
add an explicit candidate worktree revision for a real ablation. A positive candidate still requires all
seeds, the deterministic paired bootstrap comparison, artifact checksums, and
a passing suite audit.

## Operator setup

1. Build or select an immutable Nanochat Python/PyTorch image with
   `uv sync --extra gpu`, then record its image digest and tokenizer/data
   snapshots in the run provenance.
2. Add an approved candidate revision under
   `execution.candidate_worktrees`; the checked-in flagship deliberately does
   not invent one.
3. Run a single-seed smoke trial with a small
   `LONGEXPERIMENT_NANOCHAT_MAX_ITERS` value. Inspect the normalized raw result,
   then restore the declared three-seed design for the real pilot.
4. Use local CUDA or configure a reviewed Modal adapter. Do not substitute a
   shell `modal run` command for the remote-job adapter contract.

For Modal onboarding and first-pilot caps, see
[Remote GPU with Modal](../../remote-gpu-modal.md). Use an explicit cost cap
derived from Modal's current pricing; it is a cost limit, not a promise that
all permitted trials will fit within it.
