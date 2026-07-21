# Incubating: nanoGPT Controlled Ablation

The matching versioned starting point is the
[nanoGPT-ablation protocol](../../../examples/incubating/experiments/nanogpt-ablation/).

This flagship pins nanoGPT, reproduces a baseline, and evaluates candidate
worktree revisions under a fixed data split, budget, and seed set. The primary
checkout is never edited. New candidate code pauses for review before remote
execution; parameter-only trials within an approved revision can run in the
declared batch budget.

Use [`nanogpt_ablation.yaml`](../../packages/longexperiment/configs/flagships/nanogpt_ablation.yaml).
Its runner is the bundled
[`nanogpt.py`](../../packages/longexperiment/templates/runners/nanogpt.py), which executes the pinned checkout and emits
one normalized record for every configured seed/condition. Set
`LONGEXPERIMENT_NANOGPT_MAX_ITERS` for a smoke run; add an explicit candidate
worktree revision for a real ablation. A positive candidate still requires all
seeds, the deterministic paired bootstrap comparison, artifact checksums, and
a passing suite audit.

## Operator setup

1. Install a compatible Python/PyTorch environment and confirm the pinned
   nanoGPT checkout can execute `data/shakespeare_char/prepare.py` locally.
2. Add an approved candidate revision under
   `execution.candidate_worktrees`; the checked-in flagship deliberately does
   not invent one.
3. Run a single-seed smoke trial with a small
   `LONGEXPERIMENT_NANOGPT_MAX_ITERS` value. Inspect the normalized raw result,
   then restore the declared three-seed design for the real pilot.
4. Use local CUDA or configure a reviewed Modal adapter. Do not substitute a
   shell `modal run` command for the remote-job adapter contract.

For Modal onboarding and first-pilot caps, see
[Remote GPU with Modal](../remote-gpu-modal.md). A 12 A10
GPU-hour authorization cap is a sensible first real-pilot ceiling; it is a
cost limit, not a promise that all 18 permitted trials will fit within it.
