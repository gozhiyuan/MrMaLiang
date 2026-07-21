---
name: longwrite-planner
description: Use when a user wants to plan, scaffold, or customize a long-form writing project (research survey, novel, technical book) on LongWrite + MalaClaw — turns a fuzzy writing goal into a validated, runnable workflow.
---

# LongWrite Planner

You help a user go from "I want to write X" to a scaffolded, validated
LongWrite workspace with a workflow tuned to their project. You do the
planning conversation; the `maliang` and `malaclaw` CLIs do the work.

## Prerequisites

Confirm both CLIs respond before planning (offer to fix if not):

```bash
maliang template list
malaclaw flow runtimes
```

## Step 1 — Interview, briefly

Ask only what changes the plan (one round of questions, not a survey):

1. **What are they writing?** Maps to a mode: research survey/paper →
   `paper.survey`; fiction → `novel`; long technical/non-fiction →
   `technical-book`. Show the candidates with `maliang template list` and
   `maliang template show <id>`.
2. **Topic** — one sentence. This seeds intake and research.
3. **Sources** (research modes only): keyless real papers → `arxiv`;
   broader index → `semantic_scholar`; they already have a curated list →
   `seed` (they provide `sources/seed_sources.jsonl`).
4. **How hands-on do they want to be?** Every gate → `manual` cadence;
   check in once a day → `daily`; mostly autonomous → `interval` +
   `--batch-approvals`.
5. **Which worker runtimes do they have?** Run `malaclaw flow runtimes`.
   Don't plan a workflow around a runtime that isn't available.

## Step 2 — Scaffold

Prefer flags (reproducible) over the interactive wizard when you already
know the answers:

```bash
maliang init <dir> \
  --template <template-id> \
  --topic "<topic>" \
  -- \
  --research-provider <provider> \
  --review-cadence <cadence> \
  [--batch-approvals]
```

Then immediately validate: `maliang run <dir> --runtime dry-run`.
A dry run exercises the whole workflow with placeholder artifacts and
costs nothing — never hand the user a workspace that hasn't passed it.

## Step 3 — Customize the workflow (edit `<dir>/writing/longwrite.yaml`)

Only customize what the interview surfaced. The high-leverage knobs:

| User says | Edit |
| --- | --- |
| "I want to approve X before it proceeds" | `requires_human_approval: true` on that stage |
| "Keep revising until it's good" | `max_rounds: N` + `stop_when: review_score >= T` on the revise stage (metrics come from `reports/metrics.json`) |
| "Draft sections in parallel" | the `foreach` stage's `max_parallel` |
| "This step is deterministic" | `runtime: script` + a structured `command:` (no shell) |
| "Use a cheaper model for X" | per-stage `runtime:`/`model:` override |
| "Enforce my own quality bar" | `validator_commands:` running any CLI that exits non-zero with findings on stdout |

Runtime selection rule of thumb: deterministic transforms → `script`;
single-text-output stages → `openai-compatible` (local Ollama or hosted
API); stages that must read the workspace, write multiple files, or run
tools (PDF build) → `claude-code` or `codex`.

After any manifest edit: `malaclaw validate` in the workspace, then
re-run the dry run. Semantic errors (e.g. `stop_when` without
`max_rounds`, inputs no stage produces) surface there, not at runtime.

## Step 4 — Hand off

Give the user the run loop and what to expect:

```bash
maliang run <dir> --runtime <runtime>                 # runs until a gate or completion
maliang writing review agenda <dir>                    # what's waiting and why
maliang writing approve <dir> <approval-id>            # or: --batch
maliang run <dir> --runtime <runtime>                  # resume
maliang writing report daily <dir>                      # workspace digest
```

Set expectations from the shipped example
(`examples/mini-survey/README.md`): a real mini-survey took ~21 minutes
and ~276K tokens on codex, paused once for outline approval, and the
review→revise loop is what turns scaffolds into prose — a harsh round-1
review is the system working, not failing.

## Anti-patterns

- Don't write a custom mode YAML for a first project — start from a
  bundled mode and customize the scaffolded `malaclaw.yaml` instead.
- Don't route every stage to the most powerful runtime; put spend where
  judgment lives (outline, review, revise) and scripts everywhere else.
- Don't remove validators to make a run pass. Fix the stage or loosen the
  specific contract deliberately and say so.
- Don't skip the dry run. It is the only free full-workflow test.
