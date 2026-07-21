# MrMaLiang Architecture

MrMaLiang is the product boundary for LongWrite and LongExperiment. MalaClaw remains an independently versioned workflow engine and is never vendored into this repository.

Each workspace has one `maliang.yaml` source configuration. A writing-only or experiment-only template activates one component. An empirical-paper template creates a parent workspace, runs its experiment phase through MalaClaw, verifies an immutable handoff, and then resumes its writing phase through MalaClaw.

The initial coordinator intentionally keeps the component flow-state stores separate while exposing one `maliang run` lifecycle. A future workflow-composer release may compile both fragments into one MalaClaw state store; this is an operational simplification, not an evidence-contract change.

The shared `@mr-maliang/research-protocol` package owns immutable experiment-result, evidence-packet, and provenance contracts. LongExperiment produces these contracts; LongWrite consumes them.
