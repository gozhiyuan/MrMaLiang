# Mode Extension Authoring

LongWrite's workflow kernel is domain-general, but the public blueprints and
release evidence are currently paper-focused. A new novel, screenplay, book,
or other domain mode is therefore an extension project, not a claim that the
existing paper presets already validate that domain.

## Minimum contract

1. Add `configs/modes/<id>.yaml` with a safe, bounded workflow.
2. Define the mode's artifacts, ownership envelopes, and deterministic
   validators; do not reuse research-paper gates when they do not describe the
   new artifact.
3. Add a public template and a checked-in dry-run fixture.
4. Define review criteria and a release gate that are meaningful for the new
   domain, including its provenance or continuity needs.
5. Exercise creation, sync, preflight, resume, recovery, and release in an
   end-to-end example before advertising the mode as production-ready.

Use `maliang writing mode show <id>`, `maliang init`, `malaclaw validate`, and
`maliang run --runtime dry-run` while developing. Keep model prompts and any
domain-specific rubric separate from MalaClaw's execution contract: the mode
owns semantics; MalaClaw owns durable execution, observations, approvals, and
declared effects.

Existing `novel` and `technical_book` modes are useful runnable baselines.
Their public examples should not be read as evidence that a screenplay or any
other new genre has already passed this extension process.
