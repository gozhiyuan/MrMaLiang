---
name: paper-workflow
description: Operate a MrMaLiang paper workflow from template choice through preflight, approvals, release gates, and provenance archive.
---

# Paper workflow

Use this skill to run an existing paper project or to choose and initialize
one. This is an operator guide only: the stable `maliang` and `malaclaw`
commands own all workflow, evidence, experiment, and release behavior.

## 1. Choose the paper shape

Use exactly one supported paper template:

- `paper.survey` — literature-led manuscript; no experiment execution.
- `paper.empirical` — run a bounded LongExperiment suite, then import its
  audited evidence into the manuscript.
- `paper.empirical-import` — write from an existing audited experiment
  manifest; do not rerun the experiment.

Choose repository evidence only when a pinned codebase is material to the
paper's claims. A literature-only paper should not acquire a repository merely
for context. For an empirical run, choose `agentic` authoring only when
generated candidate code and the required human/lease controls are acceptable;
otherwise select `prescribed`.

Inspect the exact choices before initializing:

```bash
maliang template list
maliang template show paper.survey
maliang template show paper.empirical
maliang template show paper.empirical-import
```

## 2. Initialize reproducibly

```bash
maliang init <workspace> --template paper.survey --topic "<topic>"
maliang init <workspace> --template paper.empirical --topic "<topic>" --hypothesis "<falsifiable hypothesis>" --experiment-authoring prescribed
maliang init <workspace> --template paper.empirical-import --topic "<topic>"
```

To add material repository evidence, add one or more immutable Git sources:

```bash
maliang init <workspace> --template paper.survey --topic "<topic>" --repository <git-url-or-local-git-path>
```

For an imported empirical paper, verify the existing audited manifest before
writing:

```bash
maliang handoff import <workspace> --manifest <experiment-manifest.json>
```

## 3. Preflight, run, and resume

Preflight is required before every costly run and after material configuration
changes. It checks runtime availability, pins, and the handoff boundary without
executing the workflow.

```bash
maliang preflight <workspace> --runtime codex
maliang run <workspace> --runtime codex
maliang status <workspace>
```

When the run pauses, inspect the declared approval and the artifact it names.
Use the workflow runtime to record an accountable response, then resume the
same project:

```bash
cd <workspace>/writing
malaclaw flow review
malaclaw flow respond <approval-id> --outcome approve
cd -
maliang run <workspace> --runtime codex
```

For a revision, use a response file or `--outcome revise --feedback "..."`;
do not bypass a gate by editing state or result artifacts. Experiment phases
must reach an audited handoff before an empirical manuscript run can continue.

## 4. Interpret release gates and finish

Keep release gates intact: corpus/outline gates, citation verification, claim
support, figures/LaTeX, final research validation, and empirical-evidence
verification each protect a distinct failure mode. Diagnose and repair the
named artifact or command; do not remove validators to make a run proceed.

After a successful release, preserve the reproducible record:

```bash
maliang provenance <workspace> --event release_archived
maliang writing workspace archive <workspace>
```

Use `maliang writing report packet <workspace>` to share the bounded review
packet rather than copying unverified intermediate claims.
