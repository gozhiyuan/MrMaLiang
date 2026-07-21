# Self-Play Autonomous Empirical Paper Blueprint

This flagship exercises literature + agent-authored experiment code + audited
trials + empirical writing without a central source repository. Read the
[full runbook](../../../docs/flagships/self-play-autonomous-empirical-paper.md)
before initializing it.

```bash
maliang init self-play-agentic-paper --blueprint self-play-autonomous-empirical-paper
maliang preflight self-play-agentic-paper --runtime codex
maliang run self-play-agentic-paper --runtime codex
```

The model and benchmark revisions are fixed inputs. The agent authors only the
bounded candidate project and cannot change the primary metric, controls,
seeds, held-out split, or resource ceilings. Generated Python requires a human
code review and a dedicated worker/container before tests or smoke execution.
