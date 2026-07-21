# LongWrite Configuration Reference

This document describes the public configuration files LongWrite owns and how
they relate to MalaClaw. It reflects the current MVP implementation.

## Configuration Layers

```text
Bundled mode config
  configs/modes/<mode-id>.yaml
Bundled runtime profile
  configs/runtime-profiles/<profile-id>.yaml
    |
    | longwrite init <workspace> --mode <mode-id> --runtime-profile <profile-id> ...
    v
Generated workspace config
  <workspace>/longwrite.yaml
    |
    | longwrite sync <workspace>
    v
Derived worker inputs and workflow manifest
  <workspace>/project_brief.md
  <workspace>/malaclaw.yaml
    |
    | malaclaw validate
    | malaclaw flow run --runtime <runtime>
    v
MalaClaw flow state and artifacts
  <workspace>/.malaclaw/flow/*
  <workspace>/sources, chapters, reviews, reports, build
```

`longwrite init` is deterministic. It writes config files and starter
directories, but it does not call Codex, Claude Code, or any other LLM. LLM
workers are invoked later by `longwrite run`, which delegates execution to
MalaClaw.

`longwrite.yaml` is the user-facing source of truth after scaffolding.
`project_brief.md` and `malaclaw.yaml` are derived files. After editing
`longwrite.yaml` by hand, run:

```bash
maliang writing sync <workspace>
```

The dashboard config editor does this automatically after saving a valid
`longwrite.yaml`.

LongWrite also keeps run provenance and retention outside `longwrite.yaml` so
that changing user configuration does not erase historical execution facts.
Successful runs append `reports/run-provenance/<timestamp>.json`; see
[Workspace Retention, Archives, and Provenance](./workspace-lifecycle.md) for
the safe `keep`, `archive`, and opt-in `prune` operations.

### Research Workflow Profiles

Research papers can select a bounded workflow profile:

```yaml
research:
  workflow_profile: standard # fast | standard | deep
```

`fast` is for exploratory drafts, `standard` is the default evidence-backed
survey, and `deep` enables citation-network expansion, a second venue-metadata
upgrade pass, and a survey-structure audit. Every profile retains full-text
evidence, citation validation, LaTeX/PDF build, and final validation.

`auto_research_agentic` is the default and compiles as the full/deep workflow: multi-provider
fusion, backward and forward citation expansion, source identity
reconciliation, corpus gates, survey contract checks, double-reviewed claim
gate, and publication visuals are required release gates.

Profiles compile to MalaClaw `enabled: false` only on mode-declared
`skippable: true` stages. A disabled stage is recorded as `skipped`; it is not
silently removed. MalaClaw rejects a disabled stage whose required output feeds
an enabled downstream input unless the input is optional or externally supplied.

## Mode Config Files

Mode configs live in:

```text
configs/modes/
  auto_research_agentic.yaml
  novel.yaml
  technical_book.yaml
```

The CLI lists and displays them with:

```bash
maliang writing mode list
maliang writing mode show auto_research_agentic
```

If `--mode` is omitted, `longwrite init` defaults to
`auto_research_agentic`.

## Runtime Profile Config Files

Runtime profiles live in:

```text
configs/runtime-profiles/
  codex_first.yaml
  claude_first.yaml
  claude_advisor_sonnet.yaml  # legacy alias for claude_first
```

The CLI lists and displays them with:

```bash
maliang writing runtime-profile list
maliang writing runtime-profile show codex_first
```

If `--runtime-profile` is omitted, LongWrite uses `default`, meaning the mode's
built-in runtime defaults.

Runtime profiles do not create new writing workflows. They layer execution
policy onto any mode by compiling into MalaClaw `runtime_policy`,
`model_tiers`, and per-stage `model_tier` assignments.

Terminology:

| Term | Meaning | Examples |
| --- | --- | --- |
| MalaClaw runtime | Worker that executes one stage. | `codex`, `claude-code`, `script`, `dry-run`, `openai-api`, `ollama`. |
| LongWrite runtime profile | Preset that assigns runtime/model tiers across many stages. | `default`, `codex_first`, `claude_first` (`claude_advisor_sonnet` is a legacy alias). |

The bundled profiles focus on `codex` and `claude-code` because those CLI
harnesses can edit multiple files, run commands, use skills/MCP, and recover
from build/review failures. API/local runtimes are still available in
MalaClaw, but they are best for single-output stages unless you add a custom
profile or edit `malaclaw.yaml` directly.

```yaml
id: codex_first
name: Codex First
agent_runtime: codex
workflow:
  runtime_policy:
    primary: codex
    on_quota_exhausted: pause
  model_tiers:
    advisor:
      runtime: claude-code
      model: claude-fable-5
      requires_budget_approval: true
    executor:
      runtime: codex
  stage_model_tiers:
    outline: advisor
    review: advisor
  step_model_tiers:
    draft: executor
```

Field reference:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Profile id and filename stem. |
| `version` | no | Profile version, defaults to `1`. |
| `name` | yes | Display name. |
| `description` | no | Human-readable summary. |
| `agent_runtime` | no | Top-level MalaClaw provisioning/runtime target written into `malaclaw.yaml`. |
| `workflow.runtime_policy` | no | Merged into generated MalaClaw `workflow.runtime_policy`. |
| `workflow.model_tiers` | no | Merged into generated MalaClaw `workflow.model_tiers`. |
| `workflow.stage_model_tiers` | no | Map of stage id to model tier. Script-owned stages are left alone. |
| `workflow.step_model_tiers` | no | Map of foreach step id to model tier. Script-owned steps are left alone. |

`codex_first` marks the advisor tier with `requires_budget_approval`, so a run
can pause before spending premium model budget. This is expected. Approve the
budget gate with `longwrite approve <workspace> <approval-id>` or through the
dashboard.

### Per-stage runtime and model overrides

The default `codex` runtime does not imply a pinned OpenAI model: it runs
`codex exec` and inherits the model selected by the local Codex CLI
configuration unless the workspace supplies an override. Use
`execution.stage_overrides` for a durable workspace-specific exception:

```yaml
execution:
  stage_overrides:
    outline:
      model: gpt-5.6-sol
    quality_loop.review:
      model: gpt-5.6-terra
    quality_loop.revise:
      runtime: claude-code
      model: <model accepted by your Claude Code account>
```

The key is the generated stage path. Top-level units use their id, while a
loop child uses `quality_loop.<child-id>` and a foreach step uses
`draft_sections.draft`. Run `longwrite sync <workspace>` and
`longwrite validate config <workspace>` after editing.

Script-owned units deliberately reject runtime/model overrides. Hosted API
runtimes (`openai-api`, `openai-compatible`, `anthropic-api`, `gemini-api`,
and `ollama`) can write exactly one concrete output, so they are suitable only
for compatible units such as `search_planner`, `visual_plan`, or
`quality_loop.claim_judge`. Use Codex or Claude Code for multi-file outline,
revision, and direct-section-writing work.

This is stage-level advisor/executor orchestration. It is different from
provider-native advisor tools inside a single Anthropic API call.

### Mode Schema

LongWrite validates mode configs with `LongWriteModeDef` in
`src/lib/mode-schema.ts`.

```yaml
id: auto_research_agentic
version: 1
name: AutoResearch Agentic
description: Optional human-readable description.
artifact_type: research_paper
default_runtime:
  executor: malaclaw
  agent_runtime: codex
default_agents:
  - research-lead
pack: manuscript-writing
entry_team: manuscript-writing
artifacts:
  required:
    - project_brief.md
  optional:
    - figures/figure-plan.md
    - figures/manifest.json
    - data/*.csv
    - tables/*.md
    - paper/main.tex
    - build/manuscript.pdf
workflow:
  stages:
    - id: intake
      owner: research-lead
      outputs:
        - project_brief.md
```

Field reference:

| Field | Required | Current validation | Meaning |
| --- | --- | --- | --- |
| `id` | yes | `^[a-z0-9][a-z0-9_-]*$` | Mode id and filename stem. |
| `version` | no | number, defaults to `1` | Mode config version. |
| `name` | yes | string | Display name. |
| `description` | no | string | Human-readable summary. |
| `artifact_type` | yes | string | Writing artifact category. Currently not enum-restricted. |
| `default_runtime.executor` | no | string, defaults to `malaclaw` | Intended executor. Current implementation expects MalaClaw. |
| `default_runtime.agent_runtime` | no | `openclaw`, `claude-code`, `codex`, or `clawteam`; defaults to `codex` | Default agent runtime copied into generated manifests. |
| `default_agents` | no | string array | Domain-level agent ids used by the mode. |
| `pack` | no | string, defaults to `manuscript-writing` | MalaClaw pack id included in generated `malaclaw.yaml`. |
| `entry_team` | no | string, defaults to `manuscript-writing` | MalaClaw project entry team. |
| `artifacts.required` | no | string array | Domain-level expected artifacts. |
| `artifacts.optional` | no | string array | Domain-level optional artifacts. |
| `workflow` | yes | object with non-empty `stages`; other keys pass through | MalaClaw workflow definition. |

The mode schema is strict for LongWrite-owned fields: unknown top-level keys are
rejected. The `workflow` block is intentionally not duplicated in LongWrite;
MalaClaw owns workflow validation through `malaclaw validate`.

`default_runtime.agent_runtime` is the default written into generated
`malaclaw.yaml`. The runtime selected at execution time can still be overridden
with `longwrite run <workspace> --runtime <runtime>`.

### `artifact_type`

`artifact_type` is currently any string. Existing conventions are:

```yaml
artifact_type: research_paper
artifact_type: novel
artifact_type: book
```

`auto_research_agentic` is the maintained research-paper workflow. Use the
offline `seed` provider plus `dry-run` runtime when you need a disposable
rehearsal of the same topology.
`novel` and `technical_book` have deterministic runnable baselines with
mode-specific generators, validators, approval gates, foreach chapter drafting,
and final Markdown manuscript builds.

### Workflow Block

The `workflow` block is copied into generated `malaclaw.yaml` with mode metadata
added. It uses MalaClaw's workflow schema, including standard stages, foreach
stages, loop groups, validators, runtime overrides, approval gates, and
revision loops.

Runtime capabilities constrain valid stage shapes. For example, an API runtime
such as `openai-api` may write one concrete output file, while a stage that
declares multiple outputs or a glob output needs a `multi_file_edit` runtime
such as `codex`, `claude-code`, `script`, or `dry-run`. A stage with
`allowed_tools:` needs a CLI harness runtime. See MalaClaw's
[Workflow Runtime](https://github.com/gozhiyuan/MalaClaw/blob/main/docs/workflow-runtime.md)
reference for the full capability table and examples.

Common stage fields:

```yaml
- id: outline
  title: Outline
  owner: outline-architect
  inputs:
    - project_brief.md
  outputs:
    - outline.md
    - outline.json
  requires_human_approval: true
  validators:
    - required_output_exists
    - non_empty_markdown
```

Foreach stage example:

```yaml
- id: draft_sections
  type: foreach
  foreach: outline.sections
  item_name: section
  max_parallel: 4
  steps:
    - id: draft
      owner: chapter-writer
      outputs:
        - chapters/{{section.id}}.md
```

`foreach: outline.sections` means MalaClaw reads `outline.json` and expects
`sections` to be an array whose entries have safe string `id` values. Modes can
use another key such as `outline.chapters`; the same rule applies.

## Generated `longwrite.yaml`

`longwrite init` writes one project config into each workspace:

```yaml
version: 1
project:
  id: real-survey
  name: real-survey
  artifact_type: research_paper
  mode: auto_research_agentic
  authors:
    - name: Ada Lovelace
      email: ada@example.com
runtime_profile: codex_first
research:
  provider: multi
  # survey scores coverage/evidence/synthesis; empirical expects experiments
  paper_kind: survey
  topic: Long-horizon memory and planning in LLM agents
writing:
  target_length_words: 24000
  genre: technical survey
  audience: agent engineers
  style_instructions: concise and evidence-driven
  reference_instructions: Use supplied reports for terminology and comparison framing; do not treat them as evidence.
  reference_links: []
  reference_files: []
  output_formats:
    - markdown
review:
  cadence: daily
  time: "08:00"
  interval_hours: 4
  batch_approvals: true
```

Validate it with:

```bash
maliang writing validate config <workspace>
```

Regenerate derived files with:

```bash
maliang writing sync <workspace>
```

LongWrite validates this file with the strict `LongWriteProjectConfig` Zod
schema in `src/lib/project-config.ts`. Unknown keys are rejected so user-edited
typos do not silently change workflow behavior.

Current value reference:

### `research.paper_kind`

For `artifact_type: research_paper`, select the calibrated review rubric:

```yaml
research:
  paper_kind: survey       # default
  # or: empirical
```

`survey` scores `scope_coverage`, `evidence_fidelity`,
`comparative_synthesis`, `literature_quality`, and `clarity`. `empirical`
uses the existing experimental rubric, including `experimental_validation`.
Choose `empirical` only when an audited experiment result is part of the
workspace; it is not an appropriate hard requirement for a literature survey.

### `research.paper_profile`

Keep this separate from `paper_kind`:

```yaml
research:
  paper_kind: survey               # survey | empirical
  paper_profile: literature_survey # literature_survey | repository_study
```

`literature_survey` is the 24,000-word, 60-page flagship default. Use
`repository_study` when a pinned GitHub/local repository is the central
artifact. The profile requires a codebase input (or enabled GitHub discovery),
defaults to a focused 10,000-word scaffold with no 60-page gate, preserves a
modest scholarly background, and requires a source-grounded system architecture
diagram. Read the [Repository Study Paper Flagship Guide](../../../docs/flagships/repository-survey.md)
for the complete command and configuration. See [Paper Profiles](./paper-profiles.md)
for the profile registry boundary and extension rules.

### `research.codebases`

An agentic paper can take one or more repositories as first-class **codebase
evidence**. This applies both to a repository-centered survey and, later, to an
empirical paper whose code is executed through LongExperiment. It is a normal
paper input, not a fourth writing mode.

```yaml
research:
  paper_kind: survey # or empirical
  codebases:
    - id: longexperiment
      source: https://github.com/example/longexperiment.git
      ref: v0.1.0 # tag, branch, or commit; the resolved SHA is recorded
      title: LongExperiment
      role: primary_artifact # primary_artifact | supplementary_artifact
    - id: local-baseline
      source: ../baseline-repo
      ref: HEAD
      role: supplementary_artifact
```

`longwrite research codebases <workspace>` (also inserted automatically after
the search-plan stage) uses Git to snapshot the configured source and records
the resolved commit in `codebases/manifest.json`. It writes bounded,
inspectable code/doc evidence but never executes repository code. GitHub's API
is not required for this explicit-input path: Git itself is sufficient to clone
and pin a public repository.

### `research.codebase_discovery`

Enable this only when the paper should discover related software artifacts, not
just use repositories the operator already knows. The script turns the approved
LLM search-plan queries into bounded GitHub repository searches, filters forks,
archived repositories, licenses, and languages, and fetches a small number of
README excerpts. An LLM then selects only relevant candidates before Git pins
them as normal `@software` inputs.

```yaml
research:
  codebase_discovery:
    enabled: true
    provider: github
    query_budget: 10
    max_candidates: 40
    max_readme_fetches: 12
    max_selected: 8
    require_license: true
    include_archived: false
    languages: [TypeScript, Python]
```

The GitHub REST API works without a token at a lower rate limit. Set
`GITHUB_TOKEN` (or `GH_TOKEN`) in the workspace `.env` for reliable flagship
runs; it is never written to generated paper artifacts. Repository stars and
forks are retained as discovery metadata only and are never treated as a
scientific-quality score. The generated artifacts are
`codebases/github-candidates.json`, `codebases/github-selection.json`, and
`reports/github-codebase-selection-repair.md`.

For a `repository_study` with no explicit `research.codebases` entry, discovery
must select at least one candidate. If none is suitable, the selection-repair
report stops the run with the safe recovery choices: add a pinned explicit
repository or change the paper profile. The workflow never proceeds with an
empty repository-evidence set.

Use `[codebase:longexperiment]` or
`[codebase:longexperiment:src/runner.ts#L12-L36]` for repository-specific
claims. The renderer writes an `@software` entry in `sources/codebases.bib`.
Codebase citations are excluded from LQS, recency, accepted-venue,
arXiv-only, taxonomy-depth, and scholarly bibliography gates; use normal
literature sources for research findings and consensus claims.

### Release-quality gates for a full survey

The full modes distinguish the retrieved corpus from the bibliography readers
actually see. New deep workspaces enable the following release gates by
default; lower them only with an explicit, documented scope decision.

```yaml
research:
  release_gates:
    min_cited_sources: 80
    min_citations_per_page: 3
    min_cited_within_one_year_ratio: 0.30
    min_accepted_cited_ratio: 0.30
    max_cited_arxiv_only_ratio: 0.50
    min_citation_depths_per_section: { A: 1, B: 2, C: 2 }
    min_cited_ab_sources_per_taxonomy_cell: 2
figures:
  quality_gates:
    min_figures: 6
    min_tables: 12
    min_comparative_tables: 3
    min_verified_metadata_plots: 3
    max_nanobanana_illustrations: 1
    require_insight_statements: true
```

`min_cited_within_one_year_ratio`, `min_accepted_cited_ratio`, and
`max_cited_arxiv_only_ratio` are calculated from cited sources, not the
retrieved corpus. “Within one year” uses publication year because providers do
not reliably expose publication months. `min_accepted_cited_ratio` is
calculated from cited sources with explicit accepted/published metadata or a
DOI and non-preprint venue. `pdfinfo` counts the built PDF pages for the
density check. A visual's manifest must also carry a short `insight` statement;
captions label the artifact, while the insight states what a reader should
learn from it. Comparative-table and metadata-plot targets count only
source-grounded tables and figures backed by manifest data; Nano Banana is
capped as an orienting illustration and never counts as a data-driven plot.

### Publication presentation

```yaml
publication:
  presentation:
    citation_style: author_year   # or numeric
    show_production_statistics: true
    disclosure:
      enabled: true
      ai_use: "LongWrite and configured models supported drafting and figure planning."
      authorship: "AI-assisted research artifact; source verification remains required."
      correspondence: author@example.org
      last_updated: 2026-07-17
      version: V2
      provenance:
        enabled: true
        include_longwrite: true
        include_malaclaw: true
        include_runtime_models: true
```

`author_year` uses an author--year bibliography style; `numeric` preserves
numeric citations. The disclosure is optional and is rendered as a compact
front-matter note only when enabled. `provenance.enabled` adds the installed
LongWrite/MalaClaw identities and MalaClaw's actual per-unit runtime/model
assignments. Models remain visibly unpinned when the harness did not receive an
explicit model id; LongWrite never invents one. The compact production-
statistics table reports the woven bibliography count, figures, tables,
taxonomy cells, paper kind, and citation style from the workspace rather than
invented production claims.

New named `auto_research_agentic` workspaces enable this provenance disclosure
by default. Anonymous workspaces disable it by default. A configuration that
sets both `publication.anonymous: true` and `disclosure.enabled: true` is
rejected instead of silently suppressing the requested disclosure; choose the
appropriate submission policy explicitly.

Use `$...$` for inline math and `$$...$$` for a displayed equation in chapter
Markdown. LongWrite renders these with `amsmath`/`amssymb`; equations should
formalize a sourced definition, comparison, or analytical claim, not decorate
a survey.

For `paper_kind: empirical`, turn on the audited experiment contract instead
of treating a generated chart as experimental evidence:

```yaml
research:
  paper_kind: empirical
  experiment:
    enabled: true
    manifest_path: experiments/longexperiment-manifest.json
    min_trials: 3
```

For LongExperiment, import the audited suite manifest instead of copying
numbers manually:

```bash
maliang writing research import-experiment my-paper \
  --manifest ../my-experiment/results/experiment-manifest.json
```

Then configure `research.experiment.manifest_path` as
`experiments/longexperiment-manifest.json` and run:

```bash
maliang writing research prepare-experiment my-paper
```

LongWrite parses the complete manifest, verifies its completed per-trial
records, paired comparisons, raw-result checksum, and each copied figure/table
checksum. It writes `evidence/experiment-packets.json`, the only empirical
result context supplied to outlining, drafting, artifact planning, and review.
For a repository empirical paper, bind the result to the exact code snapshot:

```yaml
research:
  experiment:
    enabled: true
    manifest_path: experiments/longexperiment-manifest.json
    codebase_id: repo-longexperiment
    input_id: longexperiment
```

The specified LongExperiment input revision must match the resolved commit in
`codebases/manifest.json`. LongWrite does not fabricate or silently run an
experiment from a survey workflow.

### Agentic semantic screening (live-provider only)

`auto_research_agentic` can add a bounded reading bridge after deterministic
metadata triage. It is enabled in newly initialized agentic workspaces with a
live provider; it is deliberately skipped for the offline `seed` fixture.

```yaml
research:
  semantic_screen:
    enabled: true
    max_candidates: 100
    min_candidates_per_taxonomy_cell: 3
    max_evidence_sources: 32
    min_supported_claims_for_a: 2
    min_supported_claims_for_b: 1
```

The script first selects the highest-LQS candidates plus bounded reserves for
each taxonomy cell. An LLM then reads only their titles/abstracts and writes a
structured semantic-screen record. Full text is retrieved for semantically
approved candidates; a second LLM creates source evidence packets with short,
exact excerpts from locally retrieved text. A script verifies those excerpts
and allows final A/B citation depth only when the required packet exists.
Sources without that evidence are retained as C-level contextual material,
not silently discarded. `max_evidence_sources` should not exceed
`fulltext.max_core_sources`.

The same bridge is replayed inside the bounded manuscript-quality loop only
after the planner selects `targeted_research_expansion`: fresh candidates are
abstract-screened, approved full text is ingested, exact-excerpt packets are
validated, A/B depth and corpus gates are recalculated, and section evidence is
reallocated. This means a review can expose a literature gap during writing
without letting newly recalled sources bypass the evidence contract. In a round
without expansion, the existing semantic screen and source packets are
preserved; the refresh stages are idempotent validation/index work, not a new
creative research decision.

### Agentic pre-draft outline review

The live agentic workflow can run a separate bounded outline-quality loop
before human approval and chapter drafting:

```yaml
research:
  outline_review:
    enabled: true
    max_rounds: 2
    approval_mode: auto # or human
```

Each round runs the deterministic survey contract and structure audit, asks an
LLM reviewer to critique the outline against `evidence/source-packets.json`,
validates its named sections/sources, computes `outline_readiness`, and asks
the outline architect to revise. `outline_readiness = 1` requires both script
audits to pass and no major/critical reviewer finding. The final human approval
gate occurs only after this re-audited loop; `max_rounds` is deliberately
bounded from 1 to 4. `approval_mode: auto` is the agentic flagship default:
the script-owned readiness gate still must pass, but MalaClaw does not pause.
Set `approval_mode: human` to pause before initial drafting and before any
later `reopen_outline` action.

| Field | Values | Meaning |
| --- | --- | --- |
| `version` | `1` | Project config version. |
| `project.id` | slug string | Project id, defaults from workspace directory name. |
| `project.name` | string | Display name. |
| `project.artifact_type` | string | Copied from mode `artifact_type`. |
| `project.mode` | mode id | Mode used to scaffold this workspace. |
| `project.authors` | array of `{ name, email? }` | Optional writer/author metadata. Emails are useful for research paper PDF front matter. |
| `runtime_profile` | profile id | Runtime profile used by `longwrite sync`; omit for `default`. |
| `research.provider` | `seed`, `arxiv`, `semantic_scholar`, `dblp`, `crossref`, `openalex`, `multi` | Research provider for research modes. `multi` fuses live providers and is the full-mode default. OpenAlex basic Works search is keyless but `OPENALEX_API_KEY` is recommended for a deep run's larger daily allowance. |
| `research.topic` | string | User topic from `--topic`. |
| `research.semantic_screen` | object | Agentic live-provider bridge between metadata LQS and deep reading: bounded abstract-screening candidates, source-evidence budget, and A/B supported-claim minima. Stable V2 ignores it; `seed` skips it. |
| `research.outline_review` | object | Bounded live-agentic outline loop. It reviews/revises from source evidence, computes script-owned readiness, and uses `approval_mode: auto` or `human` for initial/reopened outlines. |
| `writing.target_length_words` | positive integer | Target manuscript length used by long-form generators. |
| `publication.min_pages` | positive integer | Optional release gate: the compiled PDF must contain at least this many pages. It requires `pdfinfo` and a real PDF build. |
| `writing.genre` | string | Short genre/category label: what kind of artifact this is. |
| `writing.audience` | string | Target reader profile: who the writing is for and what background it can assume. |
| `writing.style_instructions` | string | Style constraints injected into generated artifacts and later worker prompts. |
| `writing.reference_instructions` | string | Explicit instructions for how LLM writers may use supplied links/files. Injected into direct drafting and revision prompts; it cannot turn an unverified reference into a citation. |
| `writing.reference_links` | string array | Public URLs added to the project brief as optional scope/style context. Their contents are not fetched, parsed, indexed, or cited automatically. |
| `writing.reference_files` | string array | Prefer workspace-local paths under `references/` for PDFs, notes, or style samples. Paths are added to the project brief, not parsed or indexed; external absolute paths may be unavailable to a headless runtime. |
| `writing.output_formats` | `markdown`, `pdf` | Requested output formats; Markdown is the default deterministic build. Research PDFs use the LaTeX pipeline; novel PDF output is currently a basic alpha export. |
| `review.cadence` | `manual`, `daily`, `interval` | Review scheduling policy. |
| `review.time` | `HH:MM` | Daily review time. |
| `review.interval_hours` | positive integer | Interval cadence size. |
| `review.batch_approvals` | boolean | Whether batch approval is expected for review gates. |

### Workspace-local `.env` (not YAML)

`longwrite init` writes `.env.example` and ignores the real `.env` in the
workspace's `.gitignore`. Copy the example to `.env` and set only the optional
credentials you use, such as `OPENALEX_API_KEY` or
`SEMANTIC_SCHOLAR_API_KEY`. `longwrite run <workspace>` loads it before
starting MalaClaw; an already-exported shell variable takes precedence. Never
put credentials in `longwrite.yaml` or `malaclaw.yaml`. For an existing
workspace, use `longwrite env init <workspace>` to add the template without
regenerating `malaclaw.yaml`.

### Review Cadence vs Approval Gates

Review cadence is an operator schedule. It does not add, remove, or move
workflow approval gates.

Approval gates are defined in the compiled `workflow.stages` by
`requires_human_approval: true`. When a gated unit succeeds, MalaClaw pauses the
flow with `paused_for_approval` and records the artifacts to inspect.

Cadence controls how LongWrite tells you to inspect those pending gates:

| Cadence | Behavior | Typical command |
| --- | --- | --- |
| `manual` | No schedule. Check when you want. | `longwrite review agenda <workspace>` |
| `daily` | Generate daily digest/agenda guidance for `review.time`. | `longwrite report schedule <workspace>` |
| `interval` | Generate every-N-hours digest/agenda guidance. | `longwrite report schedule <workspace>` |

With a live provider, `auto_research_agentic` automatically continues after a
passing outline-readiness gate by default. Set
`research.outline_review.approval_mode: human` when an operator must approve
the initial or reopened outline. The offline `seed` rehearsal retains the base
outline gate. Clarification requests always remain explicit human pauses:

```bash
maliang writing review agenda my-survey
maliang writing report packet my-survey
maliang writing approve my-survey approve-outline-001
maliang writing approve my-survey --batch
```

Current bundled mode gates:

| Mode | Human approval gates | What to inspect |
| --- | --- | --- |
| `auto_research_agentic` | Clarification only with a live provider by default; outline approval when `approval_mode: human` (or in the offline seed rehearsal) | `outline.md`, corpus/evidence reports, then `reviews/artifact-plan.json`, `reviews/action-plan.json`, and dispatcher reports. |
| `novel` | `premise`, `plot_outline` | Premise, bibles/outline, chapter arcs before full drafting. |
| `technical_book` | `table_of_contents` | Reader profile and TOC before chapter contracts/drafts. |

AI review stages such as scorecards, continuity checks, technical reviews, and
revision loops are normal workflow stages unless their YAML sets
`requires_human_approval: true`.

Implementation note: `longwrite.yaml` is generated by `src/lib/scaffold.ts`,
validated by `src/lib/project-config.ts`, and read by status/report helpers.
`src/lib/sync.ts` compiles it back into `project_brief.md` and `malaclaw.yaml`.

## Generated `project_brief.md`

`project_brief.md` is written deterministically by `longwrite init`:

```markdown
# Project Brief

Mode: AutoResearch Agentic (auto_research_agentic)
Artifact: research_paper

## Topic

Long-horizon memory and planning in LLM agents
```

No LLM is used during this step. `longwrite sync` rewrites this file from
`longwrite.yaml`; later, the MalaClaw `intake` stage may rewrite or expand it
through the selected worker runtime.

## Word Metrics

LongWrite can report target-length progress without running a model:

```bash
maliang writing metrics words <workspace>
```

The command writes:

```text
reports/word-metrics.json
reports/word-metrics.md
```

It counts `build/manuscript.md` when present; otherwise it sums chapter files and
LaTeX section files. Fenced code blocks are ignored. If
`writing.target_length_words` is configured, the report includes progress and a
coarse status:

```text
short       below 80% of target
on_track    80% to 120% of target
long        above 120% of target
```

## Generated `malaclaw.yaml`

`malaclaw.yaml` is the executable workflow. LongWrite compiles it from:

- the selected mode config
- project id/name/topic
- research provider
- LongWrite script helpers for research/drafting/validation

For `auto_research_agentic`, the compiler injects `script` runtime commands
for deterministic stages:

```yaml
runtime: script
command:
  cmd: /path/to/node
  args:
    - /path/to/MrMaLiang/packages/longwrite/dist/cli.js
    - research
    - prepare
    - .
    - --topic
    - Long-horizon memory and planning in LLM agents
    - --provider
    - arxiv
```

The AutoResearch `initial_build` and `quality_loop.rebuild` stages are compiled
to a LongWrite script command:

```yaml
runtime: script
command:
  cmd: /path/to/node
  args:
    - /path/to/MrMaLiang/packages/longwrite/dist/cli.js
    - build
    - research
    - .
validator_commands:
  - args: [/path/to/MrMaLiang/packages/longwrite/dist/cli.js, validate, figures, .]
  - args: [/path/to/MrMaLiang/packages/longwrite/dist/cli.js, validate, latex, .]
```

The final AutoResearch `assess` stage is deterministic as well:

```yaml
runtime: script
command:
  args:
    - /path/to/MrMaLiang/packages/longwrite/dist/cli.js
    - research
    - assess
    - .
outputs:
  - reports/research-assessment.json
  - reports/research-assessment.md
  - sources/source_upgrade_plan.jsonl
```

That command computes a literature quality score, verifies `[source:<id>]`
markers against `sources/classified_sources.jsonl`,
`sources/citation_plan.jsonl`, and `sources/bibliography.bib`, and records
source metadata upgrade candidates.

`longwrite build research` creates deterministic research figures/tables first,
then writes LaTeX manuscript sources and `build/manuscript.pdf`. When
`tectonic` or `latexmk` is available, `reports/latex-build.md` reports a real
compiled PDF; otherwise LongWrite keeps a tiny placeholder PDF and says so in
the report. The current alpha LaTeX template is a simple article layout, not a
venue-specific ACM/IEEE/arXiv style. The `quality_loop.route` child is compiled to
`longwrite review route .`, while
`quality_loop.review` and `quality_loop.revise` get scorecard validation plus
`longwrite review score .`.

Generated figure/table artifacts follow this contract:

```text
data/source-years.csv
data/source-quality.csv
figures/figure-plan.md
figures/manifest.json
figures/source-years.svg
paper/figures/source-years.tex
tables/source-quality.md
paper/tables/evidence-profile.tex
paper/main.tex
paper/references.bib
paper/sections/*.tex
build/manuscript.tex
build/manuscript.pdf
```

`figures/manifest.json` records the backend and required placement for each
publication visual. `figures/placement-plan.json` assigns the source-year
figure and evidence-profile table to an outline section. LongWrite embeds each
artifact in that `paper/sections/<id>.tex` file with a caption, label, and
nearby reference; validation rejects a detached generated-artifacts appendix.
The MVP backend is `deterministic-svg`; future backends such as `mermaid`,
`python`, or `nanobanana` must provide the same placement and LaTeX-rendering
contract before they can enter the publication manifest.

### Declarative figure-spec contract

`figures/placement-plan.json` is also the declarative figure-spec contract. An
LLM may choose the analytical purpose, source set, caption, insight, and
section placement, but it cannot write plot code, TeX, coordinates, or result
values. The current source-bound forms are `concept_map`, `timelines`, and
`table_specs`:

```json
{
  "version": 1,
  "placements": [],
  "timelines": [{
    "id": "field-milestones",
    "title": "Field milestones",
    "caption": "Selected source-backed milestones.",
    "insight": "The chronology separates foundational work from later system integration.",
    "placement": { "section_id": "background", "discussion": "Motivates the historical framing." },
    "source_ids": ["source-a", "source-b", "source-c"]
  }],
  "table_specs": [{
    "id": "method-regimes",
    "kind": "comparison_matrix",
    "title": "Method regimes",
    "caption": "Source-grounded comparison of regimes.",
    "insight": "The table makes comparison conditions visible before the narrative draws conclusions.",
    "placement": { "section_id": "taxonomy", "discussion": "Anchors the taxonomy comparison." },
    "headers": ["Source", "Regime", "Limitation"],
    "rows": [{ "cells": ["Paper A", "Regime", "Limitation"], "source_ids": ["source-a"] }]
  }]
}
```

The builder verifies every source ID, derives timeline dates from classified
metadata, and generates the CSV, SVG/TeX, Markdown/longtable, labels, captions,
and manifest entries. This is appropriate for surveys and conceptual papers.
For `paper_kind: empirical`, a future LongExperiment-backed renderer will need
an additional verified results-data contract; an LLM plan alone cannot create a
results plot or claim an experiment outcome.

In agentic research mode, an initial artifact plan is generated and validated
after outline readiness but before `visual_plan` and `draft_sections`. This is
where the model may select a source-grounded formalization. Writers may use
inline `$...$` or displayed `$$...$$` math only when that intent and the section
evidence support a useful definition, objective, or comparison; every symbol
must be defined locally. A missing formula is therefore not a renderer
limitation or a reason to invent one.

The generated local manifest may contain absolute paths because it is meant to
run in the current local checkout. Its component commands are private workflow
implementation details; publish the parent `maliang` invocation instead.

## CLI Option Mapping

First-time users should prefer the wizard:

```bash
maliang init my-survey --template paper.survey --topic "A research topic"
```

For automation or README examples, use flags. Only `<dir>` is required by the
CLI; `--topic` is the one option you almost always want to provide because it
drives the project brief, research query, outline, and review criteria.

`--audience` is optional. It answers "who is this for?", not "what should it
sound like?". Use it to control assumed background, explanation depth, examples,
and review standards. Use `--style` for tone and prose constraints.

`--genre` is also optional. It answers "what kind of artifact is this?", not the
full assignment. Keep it short, usually 2-6 words:

| Mode | Good category examples | Avoid |
| --- | --- | --- |
| `auto_research_agentic` | `technical survey`, `systems comparison`, `literature review` | A paragraph-length research plan. |
| `technical_book` | `implementation guide`, `practitioner handbook`, `architecture guide` | Full table of contents. |
| `novel` | `speculative mystery`, `historical fantasy`, `near-future thriller` | Detailed plot summary. |

Put the full task in `--topic`, the reader in `--audience`, and prose rules in
`--style`.

Examples:

| Mode | Audience example | Effect |
| --- | --- | --- |
| `auto_research_agentic` | `LLM agent researchers and senior AI engineers` | Can assume agent terminology and compare papers more technically. |
| `auto_research_agentic` | `product engineers new to LLM agents` | Should explain core concepts and emphasize practical tradeoffs. |
| `technical_book` | `Python developers building their first production agent` | Should include more setup, examples, and operational guidance. |
| `novel` | `adult mystery readers who like character-driven speculative fiction` | Guides genre expectations, pacing, and review criteria. |

```bash
maliang init my-survey \
  --template paper.survey \
  --topic "Long-horizon memory and planning in LLM agents" \
  --name "My Survey" \
  -- \
  --research-provider multi \
  --review-cadence daily \
  --review-time 08:00 \
  --review-interval-hours 4 \
  --batch-approvals
```

Feedback for follow-up revision runs is explicit project state:

```bash
maliang writing feedback add my-survey --message "Make section 3 more technical."
```

That appends to `feedback/user-feedback.md`. Novel and technical-book workflows
consume it in their bounded `quality_loop`, produce
`feedback/revision-request.json`, `reviews/revision-plan.md`,
`reviews/revision-report.md`, and update `reports/metrics.json` so MalaClaw can
evaluate the loop stop condition.

Mapping:

| CLI option | Generated config field | Beginner guidance |
| --- | --- | --- |
| `<dir>` | Workspace directory and default `project.id`. | Required. Use a short folder name such as `my-survey` or `~/maliang-workspaces/my-paper`. |
| `--mode` | `project.mode`; selects `configs/modes/<mode>.yaml`. | Optional. Defaults to `auto_research_agentic`. Use `novel` or `technical_book` when needed. |
| `--id` | `project.id`. | Optional. Usually leave unset; LongWrite derives it from `<dir>`. |
| `--name` | `project.name`. | Optional display name. Usually leave unset. |
| `--author` | `project.authors[].name`; can pass multiple names. | Optional but useful for final front matter. |
| `--email` | `project.authors[].email`; paired by position with `--author`. | Optional. Mostly useful for research-paper PDFs. |
| `--topic` | `research.topic` and initial `project_brief.md`. | Strongly recommended. This is the main user intent. |
| `--research-provider` | `research.provider`; also injected into generated research script commands. | Optional. Use `seed` for free deterministic tests, `arxiv` for keyless real papers, `multi` for broader recall. |
| `--target-length-words` | `writing.target_length_words`. | Optional. Leave unset first, or set a small test target such as `3000`. |
| `--genre` | `writing.genre`. | Optional short category, such as `technical survey`, `implementation guide`, or `speculative mystery`. Leave unset if unsure. |
| `--audience` | `writing.audience`. | Optional. Set the intended reader, such as `LLM agent researchers`, `platform engineers`, or `adult mystery readers`. Leave unset if unsure. |
| `--style` | `writing.style_instructions`. | Optional. Add only if you know the desired tone; editable later. |
| `--reference-instructions` | `writing.reference_instructions`. | Optional. State how writers should use supplied links/files, for example as a terminology/style lead only. |
| `--reference-link` | `writing.reference_links`. | Optional. arXiv, DOI, and OpenReview links are exact scholarly seeds and fail closed if unresolved; other URLs remain scope/style context. |
| `--discover-repositories` | `research.codebase_discovery.enabled`. | Optional for repository surveys. Enables bounded GitHub candidate recall and LLM selection; it never executes repository code. |
| `--repository-query-budget`, `--repository-max-candidates`, `--repository-max-readmes`, `--repository-max-selected` | `research.codebase_discovery.*`. | Optional bounded discovery budgets. Defaults are 10, 40, 12, and 8. |
| `--repository-language` | `research.codebase_discovery.languages`. | Optional GitHub language filters. |
| `--include-archived-repositories`, `--allow-unlicensed-repositories` | Discovery archive/license filters. | Explicitly relax the conservative defaults. |
| `--reference-file` | `writing.reference_files`. | Optional. Add a workspace-local PDF, note, or style sample path, preferably under `references/`; it is a path lead, not parsed evidence or a verified citation. |
| `--output-format` | `writing.output_formats`; use `--output-format markdown pdf` to request PDF output. Research papers use LaTeX; novel PDF export is basic in alpha. | Optional. Defaults to `markdown`; add `pdf` after local build tooling is ready. |
| `--review-cadence` | `review.cadence`. | Optional. Defaults to `manual`, best for first runs. |
| `--review-time` | `review.time`. | Optional. Only matters when `--review-cadence daily`. |
| `--review-interval-hours` | `review.interval_hours`. | Optional. Only matters when `--review-cadence interval`. |
| `--batch-approvals` | `review.batch_approvals`. | Optional convenience flag; useful for long runs with multiple gates. |
| `--max-unit-minutes` | `run_limits.max_unit_minutes`. | Optional per-unit timeout. Agentic flagship workspaces default to `30`; choose a lower value for tight quota and a higher value only when your runtime regularly needs more time for a single drafting/review unit. |
| `--max-active-run-minutes` | `run_limits.max_active_run_minutes`. | Optional total active worker-time budget. Agentic flagship workspaces default to `1440` (24 active worker-hours); it does not include time paused for approval or provider resets. |
| `--max-recorded-tokens` | `run_limits.max_recorded_tokens`. | Optional telemetry guardrail. It pauses between units and is not a provider billing or subscription meter. |

## Extension Guidance

To add a new writing mode:

1. Add `configs/modes/<id>.yaml`.
2. Keep `id` equal to the filename stem.
3. Use a known `default_runtime.agent_runtime`.
4. Define a MalaClaw-compatible `workflow.stages` block.
5. Add or reuse templates under `templates/` if the mode needs new agents.
6. Add deterministic helpers and validators if the mode needs domain checks.
7. Run:

```bash
maliang writing mode show <id>
maliang init scratch --template <template-id> --topic "test topic"
cd scratch/writing
malaclaw validate
cd ..
maliang run . --runtime dry-run
```

Do not claim a mode is production-ready until it has at least one checked-in
end-to-end example with logs, artifacts, and validation reports.
