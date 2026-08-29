# Auto Research v2 Production Architecture

Auto Research v2 keeps research and writing agentic while making execution
deterministic. The public product remains topic plus optional Git repository to
an evidence-backed paper.

## Execution model

Every generated research-paper workflow declares IR version 2 and six durable
phases:

1. `specify` — turn product inputs into a brief and search strategy.
2. `research` — retrieve, reconcile, screen, and extract evidence.
3. `synthesize` — create and audit the taxonomy, outline, evidence allocation,
   and artifact plan.
4. `write` — draft sections and create the first complete rendered manuscript.
5. `improve` — assess release quality, route findings to allowlisted repair
   capabilities, and revalidate affected manuscript dimensions.
6. `release` — for live providers, run the hard validator and package only a
   passing manuscript. Seed remains an explicitly advisory plumbing rehearsal.

MalaClaw persists both unit state and phase state. A quota interruption,
provider timeout, approval, or process restart resumes from the affected unit;
it does not restart the intellectual phase.

## Deterministic control, agentic scholarship

Scripts own state transitions, artifact schemas, source identities, evidence
locators, gate measurements, rendering, and release eligibility. LLM workers
own literature judgment, taxonomy, synthesis, outline structure, prose,
semantic review, and the content of targeted repairs.

The `improve` phase is the only post-draft controller. A deterministic release
assessment produces findings; a validated work packet selects only registered
capabilities such as targeted research expansion, outline reopening, section
revision, or visual-plan revision. The model decides how to perform an
authorized scholarly repair but cannot add stages, lower gates, or publish.

This replaces the former duplicated manuscript-quality and final-release loops.
The maximum number of targeted rounds is configured in `longwrite.yaml`:

```yaml
research:
  quality_control:
    max_improvement_rounds: 3
```

Quality thresholds remain profile configuration rather than orchestration
code. Short and long papers share the same contracts; their presets scale the
corpus, evidence, manuscript, and release targets.
