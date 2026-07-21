# AGENTS.md

This file is the operating guide for coding agents working in MrMaLiang. Read
it before changing code, configurations, examples, or documentation.

## Project purpose

MrMaLiang is an evidence-first monorepo for long-form writing and computational
research. Its only public CLI is `maliang`. It coordinates two internal
components and delegates durable execution to the external MalaClaw runtime:

- `packages/longwrite`: literature/code evidence, outlining, drafting,
  publication artifacts, review loops, and manuscript release gates.
- `packages/longexperiment`: controlled experiment authoring/execution, trial
  auditing, statistics, provenance, and result manifests.
- `packages/research-protocol`: shared, versioned handoff/provenance schemas.
- `apps/maliang`: public templates, lifecycle coordination, CLI proxying,
  preflight, and LongExperiment-to-LongWrite handoff.
- MalaClaw (external repository): flow state, retries, approvals, limits,
  worker runtimes, supervision, and remote jobs.

Do not move MalaClaw into this monorepo or duplicate its execution engine here.

## Product contracts

The public paper templates are intentionally small:

- `paper.survey`: topic plus optional repository/discovery/reference inputs;
  never runs experiments.
- `paper.empirical`: runs a new agentic or prescribed LongExperiment, audits
  the result, then lets LongWrite write from the verified handoff.
- `paper.empirical-import`: imports an existing audited MrMaLiang-compatible
  result bundle and does not execute experiments.

Internal axes (`paperKind`, `evidenceProfile`, `experimentSource`, and optional
`experimentAuthoring`) are compiled from those templates. Preserve the
impossible-combination guards in `apps/maliang/src/templates.ts` and project
validation.

Novel and technical-book workflows use LongWrite but do not imply research or
experiment capabilities. Prescribed nanoGPT, self-play, and ProteinGym examples
under `examples/incubating/` are contract fixtures until promoted explicitly;
do not describe them as release-ready flagships.

## Architectural rule: agent judgment, deterministic verification

LLMs may decide intellectual moves such as semantic relevance, outline
structure, formalization, comparison dimensions, experiment proposals, and
revision strategy. Scripts must own schema validation, provenance, source and
code locators, trial/seed accounting, statistics, checksums, rendering, and
release gates.

Never weaken this boundary by:

- treating README claims, generated prose, or model assertions as verified
  scientific evidence;
- allowing arbitrary plotting code or invented chart data;
- permitting empirical claims without an audited experiment manifest;
- accepting an LLM JSON plan without strict schema and referential validation;
- silently falling back from live evidence to seed fixtures;
- mixing codebase citations into scholarly citation-quality metrics.

Seed-provider and dry-run workspaces are control-plane rehearsals. Their
release failures may be advisory, but live-provider releases must fail closed.

## Sources of truth

- `apps/maliang/templates/catalog.yaml`: public template catalog.
- `packages/longwrite/configs/modes/auto_research_agentic.yaml`: shared
  agentic paper stage graph before compiler transforms.
- `packages/longwrite/src/lib/paper-profiles.ts`: literature-survey versus
  repository-study targets and prompt overlays.
- `packages/longwrite/src/lib/project-config.ts`: durable LongWrite config
  schema.
- `packages/longwrite/src/lib/compiler.ts`: validated LongWrite-to-MalaClaw
  compilation and conditional stage injection.
- `packages/longexperiment/src/lib/schema.ts`: durable experiment protocol.
- `packages/longexperiment/src/lib/compiler.ts`: experiment workflow compiler.
- `packages/research-protocol/src/`: shared experiment/manuscript handoff
  contracts.

Generated workspace `malaclaw.yaml` files are outputs, not design sources.
Change the schema/config/compiler and regenerate; do not patch generated
workspaces as the product implementation.

## Repository evidence rules

Explicit and discovered repositories must be resolved to immutable commits.
Repository identity is canonicalized to prevent duplicates. Architecture and
comparison packets require exact `[codebase:<id>:path#Lx-Ly]` locators.
`CITATION.cff` is preferred for software citation metadata. Mentioned GitHub
repositories are bounded operator candidates only and are never recursively
crawled. Every primary repository must be woven into chapter prose; unused
supplementary repositories must be reported.

Recognized arXiv, DOI, and OpenReview reference links are authoritative recall
seeds and must resolve exactly. Other URLs/files remain unverified context until
they independently enter the evidence pipeline.

## Experiment evidence rules

LongExperiment results become manuscript evidence only through the shared
manifest/handoff contract. Verify individual trials, seeds, controls, status,
statistics, artifact existence, SHA-256 checksums, environment provenance, and
immutable code/data/model revisions. Repository empirical papers must join the
experiment revision to the exact repository revision analyzed by LongWrite.

Remote execution belongs to MalaClaw's remote-job lifecycle. Preserve submit,
status, collect, cancel, resumption, and provider-handle semantics rather than
wrapping remote work in an opaque detached shell command.

## Development workflow

Requirements:

- Node.js 22 or newer.
- npm workspaces.
- MalaClaw `>=1.0.0 <2.0.0` on `PATH` for integration rehearsals.

Common commands from the repository root:

```bash
npm install
npm run build
npm test
npm run release:check
npm run maliang -- template list
```

Useful focused commands:

```bash
npm test --workspace @mr-maliang/longwrite
npm test --workspace @mr-maliang/longexperiment
npm test --workspace @mr-maliang/maliang
npm run test:integration
```

Before handing off a change:

1. Run focused tests for the changed contract.
2. Run `npm run build`.
3. Run `npm test`; use `npm run release:check` for public CLI, template,
   flagship, or release behavior.
4. Run `git diff --check`.
5. For workflow-topology changes, initialize a fresh temporary workspace and
   exercise it through `maliang`, not a component CLI.

Tests should verify scenario behavior, not only scaffolding. Include malformed
LLM output, missing artifacts, stale state, revision mismatch, resumption, and
failure propagation where relevant. Network tests must use injected/fake
providers unless the test is explicitly an opt-in live rehearsal.

## CLI and documentation rules

- User documentation must use `maliang`; `longwrite` and `longexperiment` CLIs
  are internal implementation surfaces.
- MalaClaw commands remain `malaclaw ...`; MrMaLiang does not proxy the runtime
  itself.
- Keep root README, `docs/templates.md`, flagship runbooks, example blueprints,
  dashboard controls, CLI help, and config schemas consistent.
- A flagship guide must distinguish LLM stages, deterministic scripts, human
  approvals, inputs/outputs, release gates, and external prerequisites.
- Do not promise page counts, review scores, experimental outcomes, or provider
  availability. Document measurable targets and truthful failure behavior.

## Editing and repository hygiene

- Preserve unrelated user changes in a dirty worktree.
- Prefer small, contract-focused modules over copied profile-specific pipelines.
- Keep Zod schemas strict and versioned; validate paths, identifiers, and
  referential integrity at trust boundaries.
- Never commit `.env`, provider credentials, `node_modules/`, `dist/`,
  `.malaclaw/` flow state, generated workspaces, PDFs, model checkpoints, or
  large experiment artifacts.
- Store release PDFs and large contributed outputs as GitHub Release assets or
  external archives, with checksums and provenance committed in text form.
- Use immutable provenance records for accepted runs. Rebuildable indexes and
  render intermediates may be pruned; canonical evidence should be archived,
  not silently deleted.

When behavior changes, update tests and documentation in the same commit.

