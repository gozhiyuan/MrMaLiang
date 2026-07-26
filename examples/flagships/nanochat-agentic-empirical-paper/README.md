# Nanochat Agentic Empirical Paper Blueprint

This is the release candidate for the repository + agent-authored experiment +
paper path. Read the [full runbook](../../../docs/flagships/nanochat-agentic-empirical-paper.md)
before initializing it. The agent may propose and implement a bounded Nanochat
intervention, but source pins, evaluation controls, seeds, approvals, trial
budget, statistics, and empirical-paper evidence remain deterministic gates.

```bash
maliang init nanochat-agentic-paper --blueprint nanochat-agentic-empirical-paper
maliang preflight nanochat-agentic-paper --runtime codex
maliang run nanochat-agentic-paper --runtime codex
```

Run generated code only on a dedicated worker/container. Review and approve the
proposal, then every generated file before tests/smoke; approve full trials only
after the smoke diagnostics pass.
