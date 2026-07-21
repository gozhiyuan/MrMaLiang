# LongWrite Agent Architecture

> **Public source of truth:** the repository README,
> `docs/configuration.md` and `configs/modes/auto_research_agentic.yaml`
> describe the current runnable MVP. Private planning
> notes under `docs/superpowers/` are intentionally ignored.

This document defines the intended boundaries between LongWrite Agent, MalaClaw,
worker agent runtimes, writing artifacts, and external tools.

## Layer Model

```text
User
  -> LongWrite CLI / UI
  -> LongWrite mode config
  -> MalaClaw project compiler
  -> MalaClaw flow engine (deterministic stage loop)
  -> WorkerRuntime adapters (claude-code, codex, dry-run)
  -> tools and artifact workspace
  -> validators and human approval
```

## Layers

### LongWrite CLI / UI

Responsibilities:

- Ask users what they want to write.
- Recommend a mode.
- Generate editable config.
- Display status and approval requests.
- Show artifacts and validation results.

Non-responsibilities:

- Do not own general multi-agent project compilation.
- Do not hardcode every runtime contract.

### LongWrite Mode Config

Responsibilities:

- Describe writing-specific workflow stages.
- Define expected artifacts.
- Define validators.
- Define default agents and approval gates.

Examples:

- `auto_research_agentic`
- `technical_book`
- `novel`
- `custom`

### Paper Profile Registry

`auto_research_agentic` is the single paper workflow. Its profile registry
composes focused policy—literature survey or repository study—without copying
the stage graph. Profiles own output targets, codebase requirements, visual
contracts, and prompt overlays; the shared compiler, evidence pipeline, and
validators continue to own execution and verification. See [Paper
Profiles](./paper-profiles.md).

### MalaClaw Project Compiler

Responsibilities:

- Resolve packs, teams, agents, skills, and workflow definitions.
- Render runtime-specific instructions and workspace files.
- Validate topology and runtime compatibility.
- Track normalized telemetry.

Non-responsibilities:

- Do not encode novel-writing or research-paper-specific semantics directly.
- Do not become the only executor.

### MalaClaw Flow Engine + WorkerRuntime

The executor is MalaClaw's own deterministic flow engine (`malaclaw flow run`)
— not an external framework.

Engine responsibilities:

- Run ordered stages and foreach item pipelines.
- Persist stage/item state, events, and checkpoints.
- Schedule ready work bounded by parallelism caps.
- Pause for human approval; queue non-blocking review items.
- Resume after interruption.

Worker dispatch goes through the `WorkerRuntime` boundary — the engine owns
scheduling; each adapter only knows how to run one unit of work headlessly:

- `dry-run` (deterministic, for tests and CI),
- `claude-code` (`claude -p`),
- `codex` (`codex exec`),
- later: OpenClaw, direct API runtimes, local runtimes, script runtimes,
  and possibly a CrewAI crew or LangGraph graph *as one worker* — consumers
  of the workflow IR, never the engine.

### Artifact Workspace

The workspace is both the execution boundary and the audit record. LongWrite
appends run provenance with LongWrite/MalaClaw/runtime/model-policy identity and
artifact checksums after successful runs. Canonical evidence persists; only a
verified archive permits opt-in pruning of rebuildable caches. See
[workspace lifecycle](./workspace-lifecycle.md).

Responsibilities:

- Store all project outputs as inspectable files.
- Avoid hiding important state in chat history.
- Make diffs and reviews possible.

Core artifacts:

- `project_brief.md`
- `outline.md`
- `sources/*.jsonl`
- `data/*.csv`
- `figures/*.svg`
- `figures/manifest.json`
- `tables/*.md`
- `paper/*.tex`
- `notes/*.md`
- `chapters/*.md`
- `reviews/*.md`
- `reports/*.md`
- `build/*`

### Validators

Responsibilities:

- Check deterministic quality gates.
- Produce structured reports.
- Block dangerous or low-quality stage transitions when configured.

Initial validators:

- Required output exists.
- Markdown file is non-empty.
- Citation markers are present for research claims.
- Chapter ids match outline ids.
- Links are syntactically valid.
- Figure/table manifests reference existing artifacts and data files.
- LaTeX sources reference generated figure/table artifacts.
- Manuscript build outputs exist.

Later validators:

- Link reachability.
- Bibliography consistency.
- DBLP/arXiv metadata verification.
- Real LaTeX/Pandoc compilation.
- Novel continuity graph checks.
- Style drift metrics.

## Runtime Decision

> **Superseded (2026-07-04).** The current runnable MVP resolves this
> differently: the first executor is a **MalaClaw-native
> deterministic flow engine** (`malaclaw flow run`) whose stages spawn agent-CLI
> harnesses headlessly (Claude Code, Codex) via a pluggable `WorkerRuntime`
> interface. LangGraph and CrewAI are not adopted; the CrewAI Flow/Crew split is
> borrowed as a design pattern only. The workflow IR below is what keeps a
> future LangGraph or CrewAI executor possible as a later IR consumer.

The durability requirements that originally motivated LangGraph still hold —
persistence, resumability, human approval interrupts, explicit state,
stage-by-stage debugging — but they are met by the MalaClaw engine's
file-backed state (`state.json`, `events.jsonl`, checkpoints):

```text
LongWrite mode config
  -> compiled workflow IR
  -> MalaClaw flow engine (MVP)
  -> WorkerRuntime: claude-code | codex | dry-run

LongWrite mode config
  -> compiled workflow IR
  -> LangGraph / CrewAI executor (possible later, not planned for MVP)
```

## Workflow IR

A framework-neutral intermediate representation should sit between user config and
executor code.

Draft shape:

```ts
// Mirrors the snake_case Zod schema in MalaClaw's src/lib/schema.ts —
// the schemas are .strict(), so camelCase spellings are rejected.
type WorkflowStage = {
  id: string;
  title?: string;
  owner: string;
  inputs: string[];           // existence-checked by the engine
  optional_inputs: string[];  // used if present, never required
  outputs: string[];
  tools: string[];
  validators: string[];
  requires_human_approval: boolean;
  retry?: {
    max_attempts: number;
  };
  max_rounds?: number;
  stop_when?: string;
};

// Second stage kind: foreach item pipelines (see design spec §3).
// Expands over items in a machine-readable artifact; steps run in order
// per item, and different items run in parallel up to max_parallel.
type ForeachStage = {
  type: "foreach";
  id: string;
  foreach: string;        // e.g. "outline.chapters"
  item_name: string;      // template variable, e.g. {{chapter.id}}
  max_parallel: number;
  steps: WorkflowStep[];  // same shape as WorkflowStage minus stage-only fields
};
```

This IR lets LongWrite support multiple execution backends without rewriting mode
definitions.

## State Model

The current MVP uses MalaClaw's file-backed flow state, not a separate
`.longwrite` state store. LongWrite reads this state for `longwrite status`,
review agendas, and reports.

Current state files:

```text
<workspace>/.malaclaw/flow/state.json
<workspace>/.malaclaw/flow/events.jsonl
<workspace>/.malaclaw/flow/prompts/*.md
<workspace>/.malaclaw/flow/logs/*.log
```

Conceptual state shape:

```json
{
  "version": 1,
  "projectId": "long-horizon-agents-survey",
  "mode": "auto_research_agentic",
  "status": "paused_for_approval",
  "currentStage": "outline",
  "completedStages": ["intake", "recall", "score"],
  "pendingApprovals": [
    {
      "id": "approve-outline-001",
      "stage": "outline",
      "artifact": "outline.md"
    }
  ],
  "artifacts": [
    "project_brief.md",
    "sources/raw_results.jsonl",
    "sources/scored_sources.jsonl",
    "outline.md"
  ],
  "updatedAt": "2026-07-04T00:00:00Z"
}
```

## Safety and Control

LongWrite should default to conservative autonomy.

Rules:

- Do not publish or submit without human approval.
- Do not overwrite canonical drafts without a checkpoint.
- Do not claim facts without sources in research modes.
- Do not continue past outline approval unless the mode explicitly allows it.
- Keep model output, tool output, and validator reports separate.

## Open-Source Positioning

The project should be positioned as a workflow runtime and authoring layer for
long-form writing agents, not as a promise of autonomous author quality.

Good claims:

- "Builds inspectable long-writing workflows."
- "Provides reusable writing modes."
- "Persists artifacts and stage state."
- "Supports human approval gates."
- "Integrates with multi-agent runtimes."

Avoid until implemented and benchmarked:

- "Fully autonomous book writer."
- "Production ready."
- "Replicates AutoResearch V2."
- "Benchmarked writing quality."
