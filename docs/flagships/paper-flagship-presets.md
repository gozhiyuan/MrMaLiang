# Paper Flagship Presets

LongWrite has four release-grade research-paper presets. They use the same
agentic evidence, drafting, review, rendering, improvement, and release workflow;
the preset scales only the manuscript and bounded research scope.

| Preset | Use it for | Default scope | Extra requirement |
| --- | --- | --- | --- |
| `flagship_short_paper` | A focused literature survey or an economical end-to-end verification run | 8,000 words, 20 pages, 30 cited sources | None |
| `flagship_long_paper` | A broad literature survey | 24,000 words, 60 pages, 80 cited sources | None |
| `flagship_short_github_paper` | A focused paper organized around a software implementation | 6,000 words, 15 pages, 18 cited sources | One pinned GitHub or local Git repository |
| `flagship_long_github_paper` | An in-depth paper organized around a software implementation | 14,000 words, 35 pages, 40 cited sources | One pinned GitHub or local Git repository |

Short does not select a weaker workflow. Each preset keeps live-source
validation, evidence packets and citation ledgers, outline review, rendered
visual review, multi-persona quality review, bounded improvement, and final
release gates. Figures and tables remain argument-driven: a smaller paper may
need fewer artifacts, but every selected artifact receives the same evidence
and visual checks.

## Shared flagship model routing

Every newly initialized flagship writes its execution policy into
`writing/longwrite.yaml`: `gpt-5.6-luna` with medium reasoning effort is the
default, while planning and review stages use `gpt-5.6-terra` with high effort.
This is workspace configuration, not a dependency on a user's mutable Codex
configuration. Inspect or adjust it before starting a run.

## Initialize

Replace the topic, author, and optional reference URL with your own values.
All commands below create a parent workspace with its writing component.

### Short survey

Use this for a pure survey. Do not pass `--repository`.

```bash
maliang init short-survey \
  --template paper.survey \
  --name "Short Survey" \
  --topic "A focused evidence-backed survey topic" \
  --research-paper-profile flagship_short_paper \
  --reference-link "https://doi.org/10.example/replace-me" \
  -- \
  --author "Author Name" \
  --email "author@example.com" \
  --research-provider multi \
  --research-workflow-profile deep \
  --research-writing-strategy llm_sections \
  --audience "Researchers and senior practitioners" \
  --style "Evidence-first survey prose; distinguish findings, inferences, and open questions." \
  --output-format markdown pdf \
  --citation-style author_year \
  --review-cadence manual \
  --max-unit-minutes 30 \
  --max-active-run-minutes 1440 \
  --max-recorded-tokens 18000000
```

### Long survey

Use the same command with the long literature preset:

```bash
maliang init long-survey \
  --template paper.survey \
  --topic "A broad evidence-backed survey topic" \
  --research-paper-profile flagship_long_paper \
  -- \
  --research-provider multi \
  --research-workflow-profile deep
```

For the detailed long-survey operating guide, read [Long Survey Flagship
Guide](./long-agentic-survey.md).

### Short GitHub paper

Use this only when the implementation itself is a central evidence artifact.

```bash
maliang init short-github-paper \
  --template paper.survey \
  --research-paper-profile flagship_short_github_paper \
  --repository "https://github.com/owner/repository.git" \
  --topic "A focused architecture and design survey of the pinned system" \
  -- \
  --research-provider multi
```

### Long GitHub paper

```bash
maliang init long-github-paper \
  --template paper.survey \
  --research-paper-profile flagship_long_github_paper \
  --repository "https://github.com/owner/repository.git" \
  --topic "An in-depth architecture and design survey of the pinned system" \
  -- \
  --research-provider multi
```

For codebase evidence, architecture-diagram, and software-citation details,
read [Long GitHub Paper Flagship Guide](./repository-survey.md).

## Verify, run, and monitor

Run these commands after any of the initializations above:

```bash
maliang writing validate config <workspace>/writing
maliang writing sync <workspace>/writing
maliang preflight <workspace> --runtime codex
cd <workspace>/writing
malaclaw flow run --runtime codex
```

Monitor progress with `malaclaw flow status`, or start the dashboard from
`<workspace>/writing` with `malaclaw dashboard`.

Do not change paper-profile, target-length, corpus, or release-gate scope in an
in-progress run. Make that decision before initialization; then the generated
configuration, run provenance, and release report remain internally coherent.
