# Maliang CLI Unification — Design

**Date:** 2026-07-19
**Status:** Implemented
**Scope:** Make `maliang` the single public/operator CLI; keep `longwrite` and
`longexperiment` CLIs as internal implementation detail; migrate operator-facing
documentation to `maliang`.

## Problem

The `maliang` CLI (`apps/maliang`) is today a thin lifecycle orchestrator
(`template`, `init`, `run`, `status`, `provenance`, `preflight`,
`handoff`, `experiment`). It shells out to the component CLIs via `runComponent`.

The operator documentation, however, still instructs users to run ~40 distinct
`longwrite`/`longexperiment` subcommands directly (`sync`, `validate config`,
`outline revise`, the `research *`/`evidence *`/`review *`/`report *`/
`publication *`/`workspace *` families, `env init`, `retry`, `dashboard`, …),
plus the external `malaclaw` runtime commands.

We want `maliang` to be the **only** CLI an operator needs to invoke. The
component CLIs remain for (a) compiled MalaClaw stage commands and (b) package
development — they are internal, not user-facing.

A naive "find/replace `longwrite`→`maliang`" would produce non-working docs:
`maliang` does not expose those commands or the rich `init` flags, and two of its
native verbs (`preflight`, `status`) mean something different from the
same-named LongWrite commands.

## Goals

1. Operators use `maliang …` for every documented workflow action.
2. Component CLIs stay callable internally; no behavior change to generated
   MalaClaw stage commands.
3. Routing is explicitly scoped (allowlisted verbs), not a free-form
   unknown-command catch-all.
4. Argument handling never corrupts user-supplied paths.
5. Docs remain runnable and honest about verification boundaries.
6. Internal deterministic component commands are not accidentally promoted to
   the public operator surface.
7. Forwarded commands preserve component exit status and interruption behavior.

## Non-Goals

- Wrapping the external `malaclaw` runtime under `maliang`. MalaClaw is a
  versioned external dependency (per root `README.md`); docs keep calling it
  directly (`malaclaw flow runtimes`, `malaclaw validate`, …).
- Rewriting generated `malaclaw.yaml` stage commands to route through the proxy.
  These are deterministic internals and must stay direct for resumability.
- Reimplementing component command logic in `maliang`. The proxy forwards.

## Design

### 1. Proxy namespaces (primary form)

Add two forwarding command groups to `apps/maliang/src/cli.ts`:

```
maliang writing <verb...> [flags]      # -> longwrite <verb...> (writing component)
maliang experiment <verb...> [flags]   # -> longexperiment <verb...> (experiment component)
```

`maliang experiment` already exists natively (`experiment flagship`,
`experiment validate`); it is generalized around one public routing registry.
Native subcommands retain precedence. `maliang writing` is new and symmetric.
Both namespaces accept only commands registered as operator-visible. They do
not expose internal component commands such as `longexperiment stage …` or
LongWrite's generated drafting/repair helpers. Package developers may still
invoke component CLIs directly.

Examples:

```
maliang writing research prepare survey    -> longwrite research prepare <survey>/writing
maliang experiment validate study          -> longexperiment validate <study>/experiment
```

Namespace help is generated from the same registry:

```
maliang writing --help
maliang writing research --help
maliang experiment --help
```

### 2. Convenience default (secondary form)

For ergonomics, a top-level verb may be used without the `writing`/`experiment`
namespace; it **defaults to the writing component** and may be redirected with
`--component experiment`:

```
maliang research prepare survey                  # defaults to writing
maliang validate study --component experiment
```

**Restriction (typo safety):** the convenience form only accepts verbs on a
known **component-verb allowlist**. An unrecognized verb is a hard error with a
suggestion (`Unknown command 'reserch'. Run: maliang --help`), never a silent
forward. When the convenience form resolves, `maliang` emits a one-line notice
to stderr: `maliang: forwarding 'research prepare' to writing (longwrite)`.

The namespaced and convenience forms use the same registry and routing
contracts. Namespaces disambiguate the component; they do not bypass the
operator-visible allowlist.

### 3. Per-verb routing contract (argument handling)

Each public component command has a small static contract in a single routing
registry:

```ts
type VerbContract = {
  commandPath: readonly string[]; // e.g. ["research", "prepare"]
  components: readonly ("writing" | "experiment")[];
  defaultComponent: "writing" | "experiment";
  // Index among positionals after commandPath, not an index into raw argv.
  workspacePosition: number | null;
  operatorVisible: true;
};
```

Forwarding algorithm:

1. Match the longest registered command path and resolve the target component
   from the namespace or `--component`, defaulting to writing only when the
   contract permits it.
2. Parse the remaining tokens according to the contract. `workspacePosition`
   is counted among positional arguments after the command path, never across
   option names or option values. The public syntax keeps the workspace in the
   same canonical positional order as the component command. For a
   workspace-bound proxied command, required positionals through the workspace
   must appear before options; Maliang rejects ambiguous option-first forms
   rather than guessing which token is a path. Tokens after the resolved
   workspace are forwarded without reinterpretation.
3. When `workspacePosition !== null`, read the named `maliang.yaml` via
   `readMaliangProject`; resolve the component's subdir (`writing` /
   `experiment`). New MrMaLiang workspaces always use those fixed subdirectories.
4. Replace **only** that workspace positional with the resolved **absolute**
   component directory. Every other argument (source paths, artifact paths,
   `--manifest`, `--repository`, `--message`, …) is forwarded verbatim.
5. Run the component CLI with **cwd left at the user's current working
   directory**, so any relative path in a user-supplied flag resolves exactly as
   the user typed it.

**Why not set cwd to the component dir:** the existing code already
absolute-izes path-bearing flags before forwarding (e.g. `prepareHandoff`
resolves `--manifest` with `path.resolve(workspace, manifest)`). If the proxy
instead changed cwd to `<workspace>/writing` and passed `.`, a user-supplied
relative flag path (`--manifest ../verified/manifest.json`) would silently
resolve against the wrong directory. Rewriting only the declared workspace
positional to an absolute path — and leaving cwd alone — avoids both
arg-corruption and relative-path breakage. There is deliberately **no**
generic "replace any argument equal to the workspace root" behavior.

Commands with `workspacePosition: null` (for example `mode list` and
`dashboard`) forward without reading `maliang.yaml`. `runtimes` is explicitly
*not* in this category: LongWrite declares `runtimes <workspace>`, so its
workspace is resolved normally.

The registry is the public component-command surface. Commands that exist only
to support generated MalaClaw stages remain absent even if they are declared by
the component CLI.

### 4. Native-verb collisions

Two `maliang` native verbs share a name with a LongWrite command but differ in
behavior. They are **not** proxied; native behavior wins, and the native
command is made a superset where the docs need the component behavior.

| Verb | `maliang <verb>` | `longwrite <verb>` | Resolution |
| --- | --- | --- | --- |
| `preflight` | Node / MalaClaw / runner / input-pin checks | Workflow topology, Matplotlib, PDF compiler, runtime | `maliang preflight` becomes a **superset** (see §5). |
| `status` | Project + lifecycle summary | LongWrite workspace/flow status | `maliang status` stays; docs' `longwrite status` usages map to `maliang status` (the unified lifecycle view). Raw component flow status remains reachable via `maliang writing status <ws>` through the proxy for advanced use. |

### 5. Preflight unified contract

`maliang preflight <workspace> [--runtime <id>]` runs the lifecycle and
component checks and writes one unified report to
`<workspace>/reports/maliang-preflight.json`. Component-owned reports remain
intact; LongWrite continues to own `<writing>/reports/preflight.json`.

The unified report has a stable machine-readable contract and the command
returns a nonzero exit if any *required* component fails:

```json
{
  "version": 1,
  "overall": "pass",
  "writing":    { "status": "pass", "checks": [] },
  "experiment": { "status": "not_required", "checks": [] },
  "runtime":    { "status": "pass", "checks": [] }
}
```

- Runs the existing maliang lifecycle checks (`node`, `malaclaw`,
  experiment runner/inputs, writing config) as the `runtime`/component gates.
- When a writing component exists, invokes `longwrite preflight
  <ws>/writing --runtime <runtime>`, then reads and folds the component's
  generated `reports/preflight.json` into `writing`.
- Preflight uses a capture-oriented component runner that records stdout,
  stderr, and the actual child exit status. A failing component preflight is
  data to merge, not an exception that prevents the unified report from being
  written.
- `experiment.status` is `not_required` when the template has no experiment
  component.
- `overall` is `pass` only when no required component reports `fail`. Any
   required failure ⇒ `overall: "fail"` and process exit code ≠ 0.

This replaces the current line-oriented `PASS/FAIL` printout. Human-readable
lines may still be printed for convenience, but the JSON report is the contract.

### 6. `init` flag passthrough

`maliang init` keeps its native options and forwards approved LongWrite
customization arguments after `--`. Template-derived arguments come first;
approved user customization arguments come after and retain their original
ordering:

```
maliang init agent-survey \
  --template paper.survey \
  --topic "Long-horizon memory" \
  -- --author "Name" --taxonomy custom --target-length-words 40000 --output-format markdown pdf
```

Only arguments after `--` are candidates for LongWrite passthrough. Before
spawning LongWrite, Maliang validates them against an init-passthrough policy:

- Allowed: author/presentation settings, taxonomy and scope instructions,
  length/page targets, citation style, publication notes, source-quality
  thresholds, run budgets, and other non-structural LongWrite configuration.
- Reserved to Maliang/template ownership: `--mode`, `--research-paper-kind`,
  `--research-paper-profile`, `--topic`, `--repository`, `--id`, and `--name`.
  Supplying one after `--` is an actionable hard error that tells the operator
  to use the corresponding native Maliang option or select another template.
- Experiment-only templates reject nonempty LongWrite passthrough instead of
  silently ignoring it. Combined empirical templates may pass customization to
  their writing component only.

This preserves the invariant that `maliang.yaml`, the selected template, and
`longwrite.yaml` describe the same workflow. The passthrough syntax and
reserved flags are documented prominently in the quickstart and each flagship
runbook.

Implementation uses an explicit `INIT_PASSTHROUGH_OPTIONS` registry, not the
category prose above. Each entry records the exact LongWrite option name,
boolean/single/variadic value arity, and whether it is repeatable. Unknown
options fail closed. Tests keep this registry synchronized with the
operator-documented customization flags.

### 7. Error handling

- Missing `maliang.yaml` in the target dir ⇒ actionable error directing the
  operator to create a fresh workspace with `maliang init`.
- Requested `--component` absent from the project ⇒ explicit error naming the
  components the project actually has.
- Missing build (`dist/cli.js` for the component) ⇒ existing `componentExists`
  message (`MrMaLiang is not built. Run: npm run build`).
- Unknown or internal-only command in either proxy form ⇒ hard error, no
  forward, plus the nearest registered command when a useful suggestion exists.
- Missing workspace positional for a workspace-bound contract ⇒ command usage
  error before any component process is spawned.
- `--component` that conflicts with a namespace or a contract that the selected
  component does not implement ⇒ explicit error.

### 8. Process and help behavior

Forwarding is transparent at the process boundary:

- stdin/stdout/stderr remain attached for ordinary proxied commands;
- a normal child exit code becomes the Maliang exit code instead of being
  collapsed to 1;
- `SIGINT` and `SIGTERM` are forwarded to the child, and Maliang exits with the
  corresponding interrupted status;
- `maliang writing|experiment --help` and nested `--help` are served from the
  public routing registry and never expose internal stage commands;
- no-workspace inspection commands such as `mode list` require a built
  component but do not require `maliang.yaml`.

## Testing

Unit tests in `apps/maliang/tests/` for the pure routing logic (extracted so it
does not spawn processes):

- writing default vs `--component experiment` resolution;
- namespaced `maliang writing …` / `maliang experiment …` resolution;
- native-command precedence for `experiment flagship`, `experiment validate`,
  `preflight`, and `status`;
- workspace-positional rewrite to absolute component dir (and only that arg);
- `workspacePosition: null` commands (no project read or rewrite);
- `runtimes <workspace>` classified as workspace-bound;
- `--` passthrough splitting for `init`;
- allowed customization passthrough preserves ordering;
- reserved structural init flags and experiment-only passthrough are rejected;
- unknown, misspelled, and internal-only commands are rejected in both proxy
  forms;
- namespace, nested-command, and no-workspace help output;
- proxied exit-code and signal propagation;
- preflight report shape (`overall`/per-component/exit code) with a stubbed
  component preflight, including a failing component that still produces the
  unified report;

Add a documentation command-lint test that extracts shell command lines from
operator-facing Markdown and verifies that every documented proxied invocation
maps to a public routing contract. Internal generated `node …/dist/cli.js`
examples and external `malaclaw …` commands are explicitly excluded.

Then run `npm run build` and `npm test` from the repository root so component,
integration, and façade contracts are checked together.

**Verification boundary (honesty):** command *accuracy* is verified against the
CLI's argument handling and unit tests. A real end-to-end flagship run (Codex/
Claude auth, network retrieval, LaTeX/PDF) is **not** executed as part of this
work; docs are not claimed to be validated by a live paper build.

## Documentation migration

### Files with operator commands to rewrite

- `packages/longwrite/README.md`
- `packages/longwrite/CONTRIBUTING.md`
- `packages/longwrite/docs/full-auto-research-agentic-flagship.md`
- `packages/longwrite/docs/configuration.md`
- `packages/longwrite/docs/research-evidence.md`
- `packages/longwrite/docs/repository-paper-flagship.md`
- `packages/longwrite/docs/workspace-lifecycle.md`
- `packages/longwrite/docs/architecture.md`
- `packages/longwrite/docs/quickstart.md`
- `packages/longwrite/dashboard-extension/README.md`
- `packages/longwrite/skills/longwrite-planner/SKILL.md`
- `packages/longexperiment/docs/flagships/README.md`

Rewrite rules:

- Operator `longwrite <verb>` / `longexperiment <verb>` ⇒ `maliang <verb>`
  (convenience form) or `maliang writing|experiment <verb>` where the component
  is ambiguous; fix workspace paths to the `writing/`·`experiment/` layout.
- `longwrite init … <flags>` ⇒ `maliang init … -- <allowed-customization-flags>`;
  structural flags move to native Maliang options or the selected template.
- Keep `malaclaw …` lines unchanged.
- Generated MalaClaw stage commands / `node …/dist/cli.js` invocations stay and
  are explicitly labeled as internal implementation details, not operator steps.
- Flip the flagship note that currently prefers `longwrite init` over `node
  dist/cli.js` to prefer `maliang init`, with the component/`dist` paths as the
  internal/dev fallback.

### Files needing façade-framing consistency review only (no command rewrite)

These already have zero component-CLI commands; verify they present `maliang`
as the sole public façade and label MalaClaw as external:

- `README.md`
- `docs/quickstart.md`
- `docs/templates.md`
- `packages/longexperiment/docs/flagships/{nanogpt-ablation,proteingym-autoscientists,self-play-small-model}.md`

A final comprehensive `grep` across all docs confirms no stray operator-facing
`longwrite`/`longexperiment` invocation remains (the listed files are a floor,
verified exhaustively before completion).

## Rollout order

1. Implement + unit-test the proxy, namespaces, per-verb contract, preflight
   contract, and `init` passthrough in `apps/maliang`.
2. Implement process exit/signal propagation, public help generation, and the
   documentation command linter.
3. `npm run build` + `npm test` from the repository root.
4. Migrate every command-bearing operator document, including the package README.
5. Consistency pass on the façade docs.
6. Run the command linter and a final grep sweep for residual operator-facing
   component commands.
7. Perform a local seed/dry-run smoke test through `maliang`; retain the stated
   boundary that a live network/LLM/GPU flagship is a separate acceptance run.
8. Bump the unified CLI/package version to `0.2.0` and update the release notes;
   this is a new public command surface on top of the tagged `v0.1.0` baseline.
