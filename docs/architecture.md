# MrMaLiang Architecture

MrMaLiang is the product boundary for LongWrite and LongExperiment. MalaClaw remains an independently versioned workflow engine and is never vendored into this repository.

Each workspace has one `maliang.yaml` source configuration. A writing-only or experiment-only template activates one component. An empirical-paper template creates a parent workspace, runs its experiment phase through MalaClaw, verifies an immutable handoff, and then resumes its writing phase through MalaClaw.

The initial coordinator intentionally keeps the component flow-state stores separate while exposing one `maliang run` lifecycle. A future workflow-composer release may compile both fragments into one MalaClaw state store; this is an operational simplification, not an evidence-contract change.

The shared `@mr-maliang/research-protocol` package owns immutable experiment-result, evidence-packet, and provenance contracts. LongExperiment produces these contracts; LongWrite consumes them.

## Contract enforcement

**Targets are reserved before ranking.** A research target — a landmark, a
source, an evidence packet slot — enters the ledger at
`research/target-ledger.json` with an identity of its own, keyed by target key
rather than by source id, so a target that resolves later is the same target it
was while unresolved. Every selector reserves its slots first and spends what
remains on ranking. A reserved target is then either selected or excluded with
a typed reason; it may never simply disappear because generic ranking filled
the queue. Reservations that exceed a selector's capacity pause the run
**before any work starts**, because silently truncating them is the same
disappearance one layer up.

**Reachability pauses a round rather than skipping one.** An objective nothing
available can satisfy is not an objective to spend rounds on. The verdict at
`reports/reachability-verdict.json` names it before dispatch, so the run pauses
on something an operator can act on. A `when:` guard was the wrong shape: it
made an unreachable improve phase read as a phase that was skipped — a silent
non-event — when what actually happened is that a named objective cannot be met
and someone has to decide what to do about it.

The same verdict carries the failures nothing could classify. A check that
failed with `requires_diagnosis` has no routable finding, so nothing would pick
it up; listing it is how it reaches the diagnosis stage instead of stalling the
round on a red gate with no next step.
