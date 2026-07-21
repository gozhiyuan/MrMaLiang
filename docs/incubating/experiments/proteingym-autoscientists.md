# Incubating: ProteinGym / AutoScientists Compatibility

The matching versioned starting point is the
[ProteinGym / AutoScientists protocol](../../../examples/incubating/experiments/proteingym-autoscientists/).

This public biomedical flagship evaluates a pinned ProteinGym benchmark with
Spearman correlation, controls, held-out assays, and replication. The
AutoScientists checkout is an optional opaque external comparator: LongExperiment
does not vendor or schedule its internal agents. LongExperiment owns the
candidate worktree, trial, audit, and publication eligibility contracts.

Use [`proteingym_autoscientists.yaml`](../../packages/longexperiment/configs/flagships/proteingym_autoscientists.yaml). Set
`LONGEXPERIMENT_AUTOSCIENTISTS_COMMAND` to the reviewed upstream launcher;
the bundled wrapper normalizes its per-seed measurements but does not control
AutoScientists' internal agents. It exits if that command is absent rather
than emitting synthetic biomedical results. Review the design and budget before
execution.

## Operator setup

1. Clone the pinned ProteinGym and AutoScientists revisions, and confirm their
   licenses, benchmark download terms, assay selection, and heldout protocol.
2. Implement `LONGEXPERIMENT_AUTOSCIENTISTS_COMMAND` as a reviewed launcher.
   It receives `LONGEXPERIMENT_STUDY_ID`, `LONGEXPERIMENT_SEED`, and
   `LONGEXPERIMENT_CONDITION`, then must end standard output with one JSON
   metric/artifact object accepted by the wrapper.
3. Record every non-GPU cost separately: AutoScientists model/API providers,
   benchmark storage, and any gated model weights are outside Modal's GPU bill.
4. Begin with a single assay/seed smoke run. Do not approve the declared
   three-seed heldout protocol until that record and its artifact paths audit.

Modal is optional. If it becomes the GPU provider, a conservative first pilot
is 24 L40S GPU-hours ($46.83 at the documented list rate, before other costs)
with a $75–150 total authorization ceiling. Configure the provider-neutral
adapter from [Remote GPU with Modal](../remote-gpu-modal.md), not
a detached shell command.
