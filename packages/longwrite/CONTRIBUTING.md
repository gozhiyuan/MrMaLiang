# Contributing to LongWrite Agent

LongWrite is the writing product layer on top of MalaClaw. Contribute here when
the change is about long-form writing workflows, not the generic flow engine.

Good LongWrite contributions include:

- writing modes such as research papers, novels, and technical books,
- mode configs under `configs/modes/`,
- runtime profiles under `configs/runtime-profiles/`,
- research providers, citation tooling, literature-quality scoring,
- manuscript builders, LaTeX/figure/table generation,
- novel/book validators, scorecards, word metrics, feedback loops,
- the LongWrite dashboard extension tab,
- flagship examples and acceptance reports.

Generic orchestration belongs in MalaClaw instead: workflow scheduling, worker
runtimes, approvals, retries, state files, generic dashboard host behavior, and
runtime capability enforcement.

## Local Setup

Build MalaClaw first so `malaclaw` is available:

```bash
git clone https://github.com/gozhiyuan/MalaClaw.git
cd MalaClaw
npm install
npm run build
cd dashboard
npm install
npm run build
cd ..
npm link
```

Then build MrMaLiang, which includes LongWrite:

```bash
git clone https://github.com/gozhiyuan/MrMaLiang.git
cd MrMaLiang
npm install
npm run build
npm link --workspace @mr-maliang/maliang
```

If you work from sibling checkouts without `npm link`, use
`LONGWRITE_MALACLAW_BIN=/path/to/MalaClaw/dist/cli.js` for local runs.

## No-Cost Development Loop

Start with deterministic mode and dry-run runtime:

```bash
npm test
npm run build

maliang template list
maliang writing runtime-profile list

maliang init /tmp/maliang-smoke \
  --template paper.survey \
  --topic "Tool use and feedback in LLM agents" \
  -- \
  --research-provider seed \
  --review-cadence manual \
  --batch-approvals

maliang run /tmp/maliang-smoke --runtime dry-run
maliang writing approve /tmp/maliang-smoke --batch
maliang run /tmp/maliang-smoke --runtime dry-run
maliang status /tmp/maliang-smoke
maliang writing metrics words /tmp/maliang-smoke
```

This validates scaffolding, compilation, approval flow, and artifact contracts
without spending quota.

## Real-Runtime Checks

Use real runtimes only when needed:

```bash
maliang writing runtimes /tmp/maliang-smoke --runtime codex
maliang run /tmp/maliang-smoke --runtime codex
```

or:

```bash
maliang writing runtimes /tmp/maliang-smoke --runtime claude-code
maliang run /tmp/maliang-smoke --runtime claude-code
```

Real runs may spend subscription quota or API credits. Record the runtime,
model, provider, token count, and any failure modes in the example README or PR.

## Full Pre-PR Checklist

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
npm pack --dry-run
```

Current expected test coverage is roughly 25 files and 120 passing tests. Counts
may change; failures should not be ignored.

## Config Contribution Rules

`longwrite.yaml` is the user-facing source of truth. `project_brief.md` and
`malaclaw.yaml` are derived outputs.

When changing mode or runtime-profile behavior:

1. Update the Zod schema if a new public field is added.
2. Update `docs/configuration.md`.
3. Add tests for scaffold/compile/sync behavior.
4. Verify generated `malaclaw.yaml` with `malaclaw validate`.

Use these boundaries:

- `configs/modes/*.yaml`: writing product workflow shape.
- `configs/runtime-profiles/*.yaml`: model/runtime routing strategy.
- `src/lib/compiler.ts`: mode/profile to MalaClaw manifest.
- `src/lib/scaffold.ts`: workspace file creation.
- `src/lib/sync.ts`: regenerate derived files from `longwrite.yaml`.

## Dashboard Extension Rules

LongWrite owns `dashboard-extension/`. MalaClaw owns the dashboard host and
extension loader.

When changing the dashboard tab:

- keep LongWrite-specific routes in `dashboard-extension/server/`,
- keep LongWrite-specific UI in `dashboard-extension/client/`,
- use LongWrite validators before writing config,
- preserve `longwrite sync` as the path from edited config to derived files.

After dashboard changes, also run MalaClaw's dashboard tests/package smoke when
possible because the extension is loaded by the MalaClaw host.

## Flagship Examples

Examples under `examples/` are acceptance artifacts, not polished marketing
copy. Do not hand-edit generated content unless the README clearly says so.

Current flagship artifact status:

- `examples/mini-survey/build/manuscript.pdf`: final PDF present.
- `examples/tool-use-survey/build/manuscript.pdf`: final real LaTeX PDF present.
- `examples/novel-memory-city/build/manuscript.md`: final Markdown manuscript
  present; no PDF is expected for novel mode yet.

When adding an example, include:

- `README.md` with exact commands, runtime/model, provider, and human actions,
- final artifact under `build/`,
- metrics under `reports/metrics.json`,
- validation reports,
- flow event trace or a summarized trace,
- known failure modes and whether they are fixed or still open.

## Pull Request Notes

In the PR description, include:

- which mode, provider, validator, or dashboard surface changed,
- whether the change can spend model quota,
- exact commands run,
- before/after artifacts when quality changes,
- any limitations intentionally deferred.
