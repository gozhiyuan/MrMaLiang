# LongWrite Quickstart

From zero to a real research paper written by agents, with a dashboard to
watch it happen. Time: ~10 minutes of setup, then the run itself.

The default workflow is `auto_research_agentic`: the evidence-aware research
flagship with bounded LLM planning and deterministic provenance, rendering, and
release gates. The dry-run rehearsal below uses its normal workflow with the
offline `seed` provider; it does not use a separate legacy pipeline.

Read the [Full AutoResearch Agentic Flagship Guide](../../../docs/flagships/long-agentic-survey.md)
or the [Repository Study Paper Flagship Guide](../../../docs/flagships/repository-survey.md)
before spending model quota on the demo; it explains the action-plan,
operator-clarification, and recovery behavior.

## 1. Install

```bash
# From source (alpha; npm packages coming):
git clone https://github.com/gozhiyuan/MalaClaw.git
cd MalaClaw
npm install && npm run build
cd dashboard && npm install && npm run build && cd ..
npm link

cd ..
git clone https://github.com/gozhiyuan/MrMaLiang.git
cd MrMaLiang && npm install && npm run build && npm link --workspace @mr-maliang/maliang
```

Requirements: Node.js ≥ 22. For real harness stages you need an authenticated
`codex` or `claude` CLI (run `codex login` or `claude` once interactively).
No API keys are needed for the default research retrieval pipeline —
arXiv/DBLP/Crossref retrieval is keyless.

Recommended runtime path:

- first run: `dry-run` + `seed`, free and deterministic,
- cheap single-output stages: `ollama`, `openai-compatible`, `anthropic-api`,
  or `gemini-api`,
- production writing/build stages: `codex` or `claude-code`, because they have
  the CLI harness tools needed for multi-file work.

## 2. Check your runtimes

```bash
malaclaw flow runtimes
```

Each runtime lists its availability and **capabilities** (`single_output`,
`multi_file_edit`, `cli_harness_tools`, ...). You need at least one of
`codex` / `claude-code` available for real runs; `dry-run` and `script`
are always available.

Capabilities are what MalaClaw uses to validate `malaclaw.yaml`: multiple
`outputs:` need `multi_file_edit`, `allowed_tools:` needs `cli_harness_tools`,
and `command:` needs `declared_command_tool`. The full table is in
[MalaClaw's Workflow Runtime reference](https://github.com/gozhiyuan/MalaClaw/blob/main/docs/workflow-runtime.md).

## 3. Start the dashboard (optional)

MrMaLiang can register its dashboard extension and start the MalaClaw dashboard
host in one command. The tab is named **MrMaLiang** and accepts a parent
MrMaLiang workspace; use **Browse folders** rather than pasting the internal
`writing/` path:

```bash
maliang writing dashboard                    # http://127.0.0.1:3456
```

This writes/updates `~/.malaclaw/dashboard.yaml` with the MrMaLiang extension
path for the current install, preserves any other dashboard extensions, then
launches `malaclaw dashboard`. To register the extension without starting the
server:

```bash
maliang writing dashboard --install-only
malaclaw dashboard-extensions doctor   # must print ✓ (id: longwrite)
```

Extensions are trusted local code running inside the dashboard process.

## 4. Create a disposable dry-run smoke test

For a first run, use the wizard:

```bash
maliang init my-survey --template paper.survey --topic "Tool use in LLM agents"
```

For a non-interactive smoke test, the only flag you should think hard about is
`--topic`. The rest can stay default and be edited later in `longwrite.yaml` or
the dashboard.

```bash
maliang init my-survey-smoke \
  --template paper.survey \
  --topic "Tool use and environment feedback in LLM agents" \
  -- \
  --author "Ada Lovelace" \
  --email "ada@example.com" \
  --research-provider seed

maliang run my-survey-smoke --runtime dry-run   # no model or live-provider calls
maliang writing approve my-survey-smoke --batch
maliang run my-survey-smoke --runtime dry-run   # completes with fixture artifacts
```

Use `maliang init` for every new workspace. The template supplies the mode;
options after `--` customize its writing component.

Keep a `seed` dry-run workspace separate from a real project. `dry-run`
simulates LLM-owned stages, but explicitly script-locked stages still execute;
using `seed` ensures those scripts operate on deterministic local fixture data
instead of contacting live research providers.

## 5. The flagship run

```bash
maliang init my-survey \
  --template paper.survey \
  --topic "Tool use and environment feedback in LLM agents" \
  -- \
  --research-provider multi \
  --target-length-words 24000

cd my-survey
cp .env.example .env              # optional provider keys; .env is gitignored
# Edit .env to add OPENALEX_API_KEY and/or SEMANTIC_SCHOLAR_API_KEY if available.
cd ..

maliang run my-survey --runtime codex             # or claude-code
```

The flow retrieves real papers, drafts sections in parallel, then runs a
review → **LLM action plan** → allowlisted action → rebuild quality loop until
the deterministic review score reaches 8.0. The planner can select only
targeted evidence expansion, section revision, visual-plan revision, or an
operator clarification; it cannot run arbitrary commands or bypass release
gates. The research release gate fails at the round cap rather than reporting a
below-target paper as complete. A full run is multi-hour and token use varies
substantially; start with the bounded pilot guidance rather than assuming a
fixed 30-minute or 500K-token cost.

## 6. Inspect the results

```bash
maliang status my-survey
maliang writing metrics words my-survey
maliang writing report packet my-survey        # human review packet
```

Key artifacts: `build/manuscript.pdf` (real LaTeX when tectonic/latexmk is
installed), `chapters/*.md`, `reviews/scorecard.json`,
`reviews/action-plan.json`, `reports/action-dispatch.json`,
`reports/score-history.json`, and the full engine trace in
`.malaclaw/flow/events.jsonl`. In the dashboard, **Current Manuscript and
Adaptive Artifacts** previews these files, while the Flow tab shows stage
progress, loop rounds, tokens, approvals, logs, and prompts.

Each workspace retains its own artifacts: `build/manuscript.pdf`,
`chapters/*.md`, scorecards, routing reports, and the engine trace under
`.malaclaw/flow/`. Keep real runs outside the source checkout and archive a
sanitized workspace separately when it needs to be shared.

## Using API runtimes for cheap stages

Single-output stages (reviews, summaries) can run on hosted APIs or local
models instead of the CLI harnesses:

```bash
export ANTHROPIC_API_KEY=...      # anthropic-api runtime
export GEMINI_API_KEY=...         # gemini-api runtime
# or a local server:
export MALACLAW_OLLAMA_MODEL=llama3.1:8b   # ollama runtime
```

Set per-stage `runtime:`/`model_tier:` in the generated `malaclaw.yaml`, or
pick a runtime profile at init (`--runtime-profile codex_first`). Capability
mismatches (e.g. a multi-file stage on a single-output runtime) fail fast
before execution with the full list.

## Optional: Nano Banana generated figures

Deterministic figures (SVG chart, tables, mermaid/python sources) always
build free. Generated concept art is the only paid backend — off by
default, budget-gated, approval-gated:

```yaml
# longwrite.yaml
figures:
  backends:
    nanobanana:
      enabled: true
      budget_usd: 2.00
      requires_approval: true
```

```bash
export GEMINI_API_KEY=...
touch my-survey/figures/nanobanana.approved   # the explicit approval
```

Missing key or approval logs a clear skip in `reports/figures-build.md` —
never a failure. When generation succeeds, LongWrite adds the image to
`figures/manifest.json`, writes a LaTeX placement contract, and embeds it in
the selected manuscript section with a caption that identifies it as a
conceptual aid rather than empirical evidence. Every generated image has a
provenance record; the normal PDF/figure validation still applies.

## Notes on language

Novel mode auto-detects CJK topics and directs all prose into that
language. **For CJK-dominant manuscripts, `target_length_words` is
interpreted as characters (字数)** — CJK has no whitespace word boundaries,
so all length and style metrics count characters.

## Dashboard editing model

Config, personas (`roles/`), durable top-level stage overrides, and run limits are
editable in the MrMaLiang tab. Workflow **structure** (stages, loops,
validators) is edited in YAML: prefer `longwrite.yaml` + the "Sync from
longwrite.yaml" button; hand edits to compiled `malaclaw.yaml` are
advanced-mode and sync regenerates over them. Use "Validate YAML" after
hand edits — runs check nothing on file-save, but every run starts with
fail-fast validation and refuses cleanly on structural drift.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `quota_exhausted` blocker report | Worker CLI hit its plan limit | Wait for reset or switch `--runtime`; rerun `longwrite run` — the flow resumes |
| `Runtime "codex" is not available` | CLI not found or not logged in | `longwrite runtimes <dir>`; install/login the CLI; `MALACLAW_CODEX_BIN=/path` if installed elsewhere |
| Extension not loaded in dashboard | Wrong path or unbuilt extension | `malaclaw dashboard-extensions doctor` — it names the exact problem |
| `malaclaw.yaml` rejected | Schema or semantic error | `malaclaw validate` lists findings; fix the manifest, not the validator |
| Flow "paused_for_approval" | A gate is waiting on you | `longwrite review agenda <dir>`, then `longwrite approve <dir> <id>` (or `--batch`) |
| `capability mismatches` error before run | Stage needs more than its runtime can do | Change the stage `runtime:`/tier or pick a harness runtime; the error lists every mismatch |
| Missing API key for an API runtime | Key env var unset | The runtime's `detail` line in `malaclaw flow runtimes` names the exact variable |
| PDF is tiny/placeholder | No LaTeX engine installed | Install tectonic or TeX Live (latexmk); `reports/latex-build.md` shows what happened |

## Contributing

Read [`../CONTRIBUTING.md`](../CONTRIBUTING.md). Contribute writing modes,
runtime profiles, research providers, validators, manuscript builders,
scorecards, examples, and the MrMaLiang dashboard tab here. Contribute generic
workflow engine, worker runtime, approval, retry, state, and dashboard-host
behavior to MalaClaw.
