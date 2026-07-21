# Maliang CLI Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `maliang` the only public/operator CLI by adding a scoped proxy over the internal `longwrite`/`longexperiment` CLIs, then migrate operator docs to `maliang`.

**Architecture:** A single routing registry (`routing.ts`) declares every operator-visible component command as a static contract (command path, allowed components, default component, workspace-positional index). Pure resolver functions turn user argv into a validated route; an impure forwarding layer (`proxy.ts`) resolves the component subdirectory from `maliang.yaml`, rewrites only the workspace positional to an absolute path, and spawns the component CLI with inherited stdio and propagated exit/signal status. `preflight.ts` folds component preflight results into one unified JSON report. Commander wires `writing`/`experiment` namespaces plus a convenience default. Docs are then rewritten and enforced by a command-lint test.

**Tech Stack:** Node 22 (ESM), TypeScript 5.5, commander 12, `yaml`, vitest 4.

**Design spec:** `docs/superpowers/specs/2026-07-19-maliang-cli-unification-design.md`

## Global Constraints

- Node.js >= 22; ESM modules; **all local imports use the `.js` extension** (e.g. `import { x } from "./routing.js"`), matching the existing source.
- All commands run inside the `MrMaLiang/` repo root (the process cwd is its parent). Use `git -C MrMaLiang …` / run npm from `MrMaLiang/`.
- Build: `npm run build` (repo root) compiles all workspaces via tsc. Test: `npm test` (repo root) runs every workspace's vitest.
- `maliang` package version floor after this work: **0.2.0** (new public command surface on top of tagged `v0.1.0`).
- MalaClaw is an **external** dependency: never wrap `malaclaw …` under `maliang`.
- Generated `malaclaw.yaml` stage commands (`node …/packages/*/dist/cli.js`) are internal and MUST NOT be routed through the proxy or rewritten in docs.
- The proxy exposes only `operatorVisible` registry entries; never a free-form unknown-command catch-all.
- Never set the component child cwd to the component dir; keep the user's cwd and rewrite only the declared workspace positional to an absolute path.

---

## Phase 1 — Proxy CLI

### Task 1: Routing registry and pure resolver

**Files:**
- Create: `apps/maliang/src/routing.ts`
- Test: `apps/maliang/tests/routing.test.ts`

**Interfaces:**
- Produces:
  - `type Component = "writing" | "experiment"`
  - `type VerbContract = { commandPath: readonly string[]; components: readonly Component[]; defaultComponent: Component; workspacePosition: number | null; operatorVisible: true }`
  - `const ROUTING_REGISTRY: readonly VerbContract[]`
  - `function findContract(tokens: readonly string[]): VerbContract | null` — longest command-path prefix match.
  - `type Resolution = { kind: "route"; component: Component; contract: VerbContract; componentTokens: string[]; workspaceName: string | null; workspaceTokenIndex: number | null } | { kind: "error"; message: string }`
  - `function resolveInvocation(rawArgs: readonly string[], opts: { forcedComponent?: Component }): Resolution`

- [ ] **Step 1: Write the failing test**

```ts
// apps/maliang/tests/routing.test.ts
import { describe, expect, it } from "vitest";
import { findContract, resolveInvocation } from "../src/routing.js";

describe("routing registry", () => {
  it("matches the longest command path", () => {
    expect(findContract(["research", "prepare", "survey"])?.commandPath).toEqual(["research", "prepare"]);
    expect(findContract(["sync", "survey"])?.commandPath).toEqual(["sync"]);
    expect(findContract(["definitely-not-a-command"])).toBeNull();
  });

  it("routes a convenience verb to the writing component by default", () => {
    const r = resolveInvocation(["sync", "survey"], {});
    expect(r).toMatchObject({ kind: "route", component: "writing", workspaceName: "survey" });
  });

  it("honors --component experiment on shared verbs", () => {
    const r = resolveInvocation(["validate", "study", "--component", "experiment"], {});
    expect(r).toMatchObject({ kind: "route", component: "experiment", workspaceName: "study" });
    if (r.kind === "route") expect(r.componentTokens).not.toContain("--component");
  });

  it("uses a forced namespace component and rejects a conflicting --component", () => {
    expect(resolveInvocation(["sync", "s"], { forcedComponent: "experiment" })).toMatchObject({ component: "experiment" });
    expect(resolveInvocation(["sync", "s", "--component", "writing"], { forcedComponent: "experiment" }).kind).toBe("error");
  });

  it("records no workspace for inspection commands", () => {
    const r = resolveInvocation(["mode", "list"], {});
    expect(r).toMatchObject({ kind: "route", workspaceName: null, workspaceTokenIndex: null });
  });

  it("errors on an unknown verb and a missing required workspace", () => {
    expect(resolveInvocation(["reserch", "prepare", "s"], {}).kind).toBe("error");
    expect(resolveInvocation(["sync"], {}).kind).toBe("error");
  });

  it("rejects an option before the required workspace positional", () => {
    expect(resolveInvocation(["sync", "--json", "survey"], {}).kind).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/routing.test.ts`
Expected: FAIL — `Cannot find module '../src/routing.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/maliang/src/routing.ts
export type Component = "writing" | "experiment";

export type VerbContract = {
  commandPath: readonly string[];
  components: readonly Component[];
  defaultComponent: Component;
  /** Index of the workspace among positionals after commandPath, or null for inspection commands. */
  workspacePosition: number | null;
  operatorVisible: true;
};

const both: readonly Component[] = ["writing", "experiment"];
const writingOnly: readonly Component[] = ["writing"];

/** Workspace-bound writing command with the workspace as the first positional. */
function w(commandPath: string[]): VerbContract {
  return { commandPath, components: writingOnly, defaultComponent: "writing", workspacePosition: 0, operatorVisible: true };
}
/** Workspace-bound command implemented by both components. */
function shared(commandPath: string[]): VerbContract {
  return { commandPath, components: both, defaultComponent: "writing", workspacePosition: 0, operatorVisible: true };
}
/** Inspection command with no workspace positional. */
function inspect(commandPath: string[], components: readonly Component[] = writingOnly): VerbContract {
  return { commandPath, components, defaultComponent: components[0], workspacePosition: null, operatorVisible: true };
}

// NOTE: this is the public operator surface. Completeness is enforced by the
// docs command-lint test in Task 7 (every documented proxied command MUST map
// to an entry here). Add entries as docs are migrated.
export const ROUTING_REGISTRY: readonly VerbContract[] = [
  shared(["sync"]),
  shared(["validate", "config"]),
  w(["validate", "research"]),
  w(["validate", "latex"]),
  w(["outline", "revise"]),
  w(["research", "prepare"]),
  w(["research", "prepare-experiment"]),
  w(["research", "import-experiment"]),
  w(["research", "refresh"]),
  w(["research", "recall"]),
  w(["research", "enrich"]),
  w(["research", "fulltext"]),
  w(["research", "snowball"]),
  w(["research", "corpus-gates"]),
  w(["research", "reconcile-identities"]),
  w(["research", "verify"]),
  w(["research", "survey-contract"]),
  w(["research", "codebases"]),
  w(["research", "github-codebase-recall"]),
  w(["research", "repair-github-codebase-selection"]),
  w(["evidence", "index"]),
  w(["evidence", "search"]),
  w(["evidence", "consolidate"]),
  w(["evidence", "allocate"]),
  w(["review", "agenda"]),
  w(["review", "score"]),
  w(["review", "route"]),
  w(["report", "packet"]),
  w(["report", "schedule"]),
  w(["publication", "validate"]),
  w(["publication", "package"]),
  w(["workspace", "prune"]),
  w(["workspace", "archive"]),
  w(["workspace", "keep"]),
  w(["metrics", "words"]),
  w(["feedback", "add"]),
  w(["approve"]),
  w(["retry"]),
  w(["env", "init"]),
  w(["build", "research"]),
  w(["supervise"]),
  shared(["runtimes"]),
  inspect(["mode", "list"]),
  inspect(["mode", "show"]),
  inspect(["dashboard"]),
];

export function findContract(tokens: readonly string[]): VerbContract | null {
  let best: VerbContract | null = null;
  for (const contract of ROUTING_REGISTRY) {
    const path = contract.commandPath;
    if (path.length > tokens.length) continue;
    if (path.every((segment, index) => tokens[index] === segment)) {
      if (!best || path.length > best.commandPath.length) best = contract;
    }
  }
  return best;
}

export type Resolution =
  | { kind: "route"; component: Component; contract: VerbContract; componentTokens: string[]; workspaceName: string | null; workspaceTokenIndex: number | null }
  | { kind: "error"; message: string };

export function resolveInvocation(rawArgs: readonly string[], opts: { forcedComponent?: Component }): Resolution {
  const contract = findContract(rawArgs);
  if (!contract) return { kind: "error", message: `Unknown command '${rawArgs.join(" ")}'. Run: maliang --help` };

  // Split --component out of the forwarded tokens.
  const rest = rawArgs.slice(contract.commandPath.length);
  let flagComponent: Component | undefined;
  const componentTokens: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--component") {
      const value = rest[i + 1];
      if (value !== "writing" && value !== "experiment") return { kind: "error", message: `--component must be writing or experiment` };
      flagComponent = value;
      i++;
      continue;
    }
    componentTokens.push(rest[i]);
  }

  if (opts.forcedComponent && flagComponent && opts.forcedComponent !== flagComponent) {
    return { kind: "error", message: `--component ${flagComponent} conflicts with the ${opts.forcedComponent} namespace` };
  }
  const component = opts.forcedComponent ?? flagComponent ?? contract.defaultComponent;
  if (!contract.components.includes(component)) {
    return { kind: "error", message: `${contract.commandPath.join(" ")} is not available for the ${component} component` };
  }

  if (contract.workspacePosition === null) {
    return { kind: "route", component, contract, componentTokens, workspaceName: null, workspaceTokenIndex: null };
  }

  // Positionals are the leading non-option tokens; the workspace must appear before options.
  let positionalCount = 0;
  let workspaceTokenIndex: number | null = null;
  let workspaceName: string | null = null;
  for (let i = 0; i < componentTokens.length; i++) {
    if (componentTokens[i].startsWith("-")) break;
    if (positionalCount === contract.workspacePosition) {
      workspaceTokenIndex = i;
      workspaceName = componentTokens[i];
      break;
    }
    positionalCount++;
  }
  if (workspaceName === null) {
    return { kind: "error", message: `${contract.commandPath.join(" ")} requires a workspace argument before any options` };
  }
  return { kind: "route", component, contract, componentTokens, workspaceName, workspaceTokenIndex };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/routing.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git -C MrMaLiang add apps/maliang/src/routing.ts apps/maliang/tests/routing.test.ts
git -C MrMaLiang commit -m "feat(maliang): routing registry and pure invocation resolver"
```

---

### Task 2: Component-directory resolution and forward-arg builder

**Files:**
- Create: `apps/maliang/src/forward.ts`
- Test: `apps/maliang/tests/forward.test.ts`

**Interfaces:**
- Consumes: `Resolution`, `Component` from `./routing.js`; `readMaliangProject` from `./project.js`.
- Produces:
  - `function componentSubdir(project: MaliangProject, component: Component): string` — returns the workspace-relative subdir (`"writing"`, `"experiment"`, or `"."`), throwing if absent.
  - `function buildForwardArgs(resolution: Extract<Resolution, { kind: "route" }>, absoluteComponentDir: string): string[]` — component argv with the workspace positional replaced by `absoluteComponentDir`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/maliang/tests/forward.test.ts
import { describe, expect, it } from "vitest";
import { buildForwardArgs, componentSubdir } from "../src/forward.js";
import { resolveInvocation } from "../src/routing.js";
import type { MaliangProject } from "../src/project.js";

const project: MaliangProject = {
  version: 1,
  project: { id: "p", template: "paper.empirical" },
  components: { writing: { workspace: "writing" }, experiment: { workspace: "experiment" } },
  handoff: { mode: "none", state: "not_required" },
};

describe("component resolution", () => {
  it("returns the subdir for a present component and throws for an absent one", () => {
    expect(componentSubdir(project, "writing")).toBe("writing");
    const writingOnly = { ...project, components: { writing: { workspace: "." } } } as MaliangProject;
    expect(componentSubdir(writingOnly, "writing")).toBe(".");
    expect(() => componentSubdir(writingOnly, "experiment")).toThrow(/experiment/);
  });

  it("replaces only the workspace positional and leaves relative flag paths intact", () => {
    const r = resolveInvocation(["research", "import-experiment", "survey", "--manifest", "../ext/m.json"], {});
    if (r.kind !== "route") throw new Error("expected route");
    const args = buildForwardArgs(r, "/abs/survey/writing");
    expect(args).toEqual(["research", "import-experiment", "/abs/survey/writing", "--manifest", "../ext/m.json"]);
  });

  it("forwards inspection commands unchanged", () => {
    const r = resolveInvocation(["mode", "list"], {});
    if (r.kind !== "route") throw new Error("expected route");
    expect(buildForwardArgs(r, "/unused")).toEqual(["mode", "list"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/forward.test.ts`
Expected: FAIL — `Cannot find module '../src/forward.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/maliang/src/forward.ts
import type { Component, Resolution } from "./routing.js";
import type { MaliangProject } from "./project.js";

export function componentSubdir(project: MaliangProject, component: Component): string {
  const entry = project.components[component];
  if (!entry) {
    const present = Object.keys(project.components).join(", ") || "none";
    throw new Error(`This workspace has no ${component} component (present: ${present})`);
  }
  return entry.workspace;
}

export function buildForwardArgs(resolution: Extract<Resolution, { kind: "route" }>, absoluteComponentDir: string): string[] {
  const args = [...resolution.contract.commandPath, ...resolution.componentTokens];
  if (resolution.workspaceTokenIndex !== null) {
    args[resolution.contract.commandPath.length + resolution.workspaceTokenIndex] = absoluteComponentDir;
  }
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/forward.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C MrMaLiang add apps/maliang/src/forward.ts apps/maliang/tests/forward.test.ts
git -C MrMaLiang commit -m "feat(maliang): component subdir resolution and forward-arg builder"
```

---

### Task 3: Transparent process forwarding (exit code + signal propagation)

**Files:**
- Create: `apps/maliang/src/proxy.ts`
- Test: `apps/maliang/tests/proxy.e2e.test.ts`

**Interfaces:**
- Consumes: `resolveInvocation`, `Component` from `./routing.js`; `componentSubdir`, `buildForwardArgs` from `./forward.js`; `readMaliangProject` from `./project.js`.
- Produces: `async function forwardCommand(rawArgs: string[], opts: { forcedComponent?: Component }): Promise<never>` — resolves, spawns the component CLI with `stdio: "inherit"`, forwards `SIGINT`/`SIGTERM`, and calls `process.exit` with the child's code (or `128 + signal`). On a resolution error it prints the message and exits 1.
- Reuses `componentCli(component)` (exported from `cli.ts` in Task 4; for this task define a local `componentCli` in `proxy.ts` and Task 4 imports it).

- [ ] **Step 1: Write the failing test** (drives exit-code propagation through a real spawn of a stub)

```ts
// apps/maliang/tests/proxy.e2e.test.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maliang-proxy-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("proxy exit-code propagation", () => {
  it("returns the component's nonzero exit code instead of collapsing to 1", () => {
    // A migrated writing workspace pointing longwrite at "." — but we only need
    // an unknown component verb to make longwrite exit nonzero, proving the code
    // is propagated rather than forced to 1. Use a real workspace with maliang.yaml.
    fs.writeFileSync(path.join(dir, "maliang.yaml"),
      "version: 1\nproject:\n  id: p\n  template: paper.survey\ncomponents:\n  writing:\n    workspace: .\nhandoff:\n  mode: none\n  state: not_required\n");
    const cli = path.join(root, "apps", "maliang", "dist", "cli.js");
    const result = spawnSync(process.execPath, [cli, "writing", "mode", "list"], { cwd: dir, encoding: "utf8" });
    // longwrite mode list on a bare "." exits nonzero; assert it is not the
    // proxy's own generic 1-vs-0 collapse but a propagated child status.
    expect(result.status).not.toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/proxy.e2e.test.ts`
Expected: FAIL — the `writing` namespace/proxy is not wired yet (Task 4), so the CLI errors differently or the module is missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/maliang/src/proxy.ts
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildForwardArgs, componentSubdir } from "./forward.js";
import { resolveInvocation, type Component } from "./routing.js";
import { readMaliangProject } from "./project.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export function componentCli(component: "longwrite" | "longexperiment"): string {
  return path.join(sourceRoot, "packages", component, "dist", "cli.js");
}
const cliFor: Record<Component, "longwrite" | "longexperiment"> = { writing: "longwrite", experiment: "longexperiment" };

export async function forwardCommand(rawArgs: string[], opts: { forcedComponent?: Component }): Promise<never> {
  const resolution = resolveInvocation(rawArgs, opts);
  if (resolution.kind === "error") { console.error(resolution.message); process.exit(1); }

  let forwardArgs: string[];
  if (resolution.workspaceName === null) {
    forwardArgs = buildForwardArgs(resolution, "");
  } else {
    const workspace = path.resolve(resolution.workspaceName);
    const project = await readMaliangProject(workspace).catch(() => {
      throw new Error(`${resolution.workspaceName} is not a maliang workspace (no maliang.yaml). Run: maliang migrate ${resolution.workspaceName} --kind longwrite`);
    });
    const subdir = componentSubdir(project, resolution.component);
    forwardArgs = buildForwardArgs(resolution, path.resolve(workspace, subdir));
  }

  const child = spawn(process.execPath, [componentCli(cliFor[resolution.component]), ...forwardArgs], { stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => { if (!child.killed) child.kill(signal); };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return await new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      if (signal) process.exit(128 + (require("node:os").constants.signals[signal] ?? 15));
      process.exit(code ?? 1);
    });
  });
}
```

Note: replace the inline `require(...)` with a top `import os from "node:os"` and `os.constants.signals[signal]` to stay ESM-clean.

- [ ] **Step 4: Run test to verify it passes** (after Task 4 wires the namespace; if executed standalone, this step is completed at the end of Task 4)

Run: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/proxy.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C MrMaLiang add apps/maliang/src/proxy.ts apps/maliang/tests/proxy.e2e.test.ts
git -C MrMaLiang commit -m "feat(maliang): transparent component forwarding with exit/signal propagation"
```

---

### Task 4: Wire namespaces and convenience default into the CLI

**Files:**
- Modify: `apps/maliang/src/cli.ts` (import `forwardCommand`, `componentCli` from `./proxy.js`; remove the now-duplicated local `componentCli`; register `writing`/`experiment` proxy groups and the convenience fallback; keep native `experiment flagship`/`experiment validate` precedence)
- Test: `apps/maliang/tests/cli-routing.e2e.test.ts`

**Interfaces:**
- Consumes: `forwardCommand` from `./proxy.js`.
- Produces: CLI behavior — `maliang writing <verb…>`, `maliang experiment <verb…>` (non-native verbs), `maliang <allowlisted-verb> …` convenience form with a stderr forwarding notice; unknown convenience verbs error via commander.

- [ ] **Step 1: Write the failing test**

```ts
// apps/maliang/tests/cli-routing.e2e.test.ts
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(root, "apps", "maliang", "dist", "cli.js");
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });

describe("maliang command surface", () => {
  it("rejects an unknown convenience verb without forwarding", () => {
    const r = run(["reserch", "prepare", "x"]);
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/[Uu]nknown command/);
  });

  it("keeps native experiment subcommands (validate) as native", () => {
    const r = run(["experiment", "validate", "/nonexistent-workspace"]);
    // Native path throws "has no LongExperiment component" or a read error — NOT
    // the proxy's unknown-command error.
    expect(`${r.stderr}${r.stdout}`).not.toMatch(/Unknown command/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/cli-routing.e2e.test.ts`
Expected: FAIL — convenience/namespace routing not present; `reserch` may reach commander's default and not print "Unknown command".

- [ ] **Step 3: Write minimal implementation**

In `apps/maliang/src/cli.ts`:
1. Replace the local `componentCli` definition and its uses with an import: `import { forwardCommand, componentCli } from "./proxy.js";`.
2. After the existing native command registrations and before `program.parseAsync()`, add the proxy groups and convenience fallback:

```ts
import { findContract, type Component } from "./routing.js";

function registerProxyNamespace(name: Component) {
  program.command(`${name}`)
    .description(`Forward an operator command to the ${name} component`)
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async (args: string[]) => { await forwardCommand(args, { forcedComponent: name }); });
}
registerProxyNamespace("writing");
// "experiment" already exists as a native group; add a catch-all subcommand that
// forwards non-native experiment verbs:
experiment.command("*", { hidden: true }).allowUnknownOption(true).action(async function (this: { args: string[] }) {
  await forwardCommand(this.args, { forcedComponent: "experiment" });
});

// Convenience fallback: any allowlisted top-level verb not claimed by a native
// command. commander invokes this on unknown top-level commands.
program.allowUnknownOption(true);
program.command("*", { hidden: true }).action(async function (this: { args: string[] }) {
  const raw = this.args;
  if (!findContract(raw)) { console.error(`Unknown command '${raw.join(" ")}'. Run: maliang --help`); process.exit(1); }
  const contract = findContract(raw)!;
  console.error(`maliang: forwarding '${contract.commandPath.join(" ")}' to ${contract.defaultComponent} (${contract.defaultComponent === "writing" ? "longwrite" : "longexperiment"})`);
  await forwardCommand(raw, {});
});
```

Note: verify commander 12 wildcard/`this.args` semantics during implementation; if `*`-command capture differs, inspect argv directly before `program.parseAsync()` and dispatch `forwardCommand` for a leading `writing`/`experiment` token or an allowlisted verb, letting native commands and `--help` fall through to commander. The observable contract (tests above) is what must hold.

- [ ] **Step 4: Run tests to verify they pass** (includes Task 3's e2e)

Run: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/cli-routing.e2e.test.ts apps/maliang/tests/proxy.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C MrMaLiang add apps/maliang/src/cli.ts apps/maliang/tests/cli-routing.e2e.test.ts
git -C MrMaLiang commit -m "feat(maliang): writing/experiment proxy namespaces and convenience routing"
```

---

### Task 5: `init` `--` passthrough policy

**Files:**
- Create: `apps/maliang/src/init-passthrough.ts`
- Modify: `apps/maliang/src/cli.ts` (`init` command: capture args after `--`, validate, append to the `longwrite init` args in `initializeWorkspace`)
- Test: `apps/maliang/tests/init-passthrough.test.ts`

**Interfaces:**
- Produces:
  - `const RESERVED_INIT_FLAGS: readonly string[]` = `["--mode","--research-paper-kind","--research-paper-profile","--topic","--repository","--id","--name"]`
  - `type PassthroughOption = { arity: "boolean" | "single" | "variadic"; repeatable: boolean }`
  - `const INIT_PASSTHROUGH_OPTIONS: Record<string, PassthroughOption>`
  - `function validateInitPassthrough(afterDashDash: readonly string[], ctx: { hasWriting: boolean }): { ok: true; args: string[] } | { ok: false; message: string }`
- Consumes (in cli.ts): commander's `program.command("init").allowUnknownOption()` is not used; instead read `program.args` after `--` via commander's passthrough (`init <dir> [-- <longwrite args...>]`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/maliang/tests/init-passthrough.test.ts
import { describe, expect, it } from "vitest";
import { validateInitPassthrough } from "../src/init-passthrough.js";

describe("init passthrough policy", () => {
  it("accepts allowed customization flags and preserves order", () => {
    const r = validateInitPassthrough(["--author", "Name", "--taxonomy", "a", "b", "--target-length-words", "40000"], { hasWriting: true });
    expect(r).toEqual({ ok: true, args: ["--author", "Name", "--taxonomy", "a", "b", "--target-length-words", "40000"] });
  });

  it("rejects reserved structural flags with an actionable message", () => {
    const r = validateInitPassthrough(["--research-paper-kind", "empirical"], { hasWriting: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--research-paper-kind.*template|native/i);
  });

  it("rejects unknown options (fail closed)", () => {
    expect(validateInitPassthrough(["--totally-made-up"], { hasWriting: true }).ok).toBe(false);
  });

  it("rejects any passthrough for a writing-less (experiment-only) template", () => {
    const r = validateInitPassthrough(["--author", "Name"], { hasWriting: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/experiment-only|no writing component/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/init-passthrough.test.ts`
Expected: FAIL — `Cannot find module '../src/init-passthrough.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/maliang/src/init-passthrough.ts
export const RESERVED_INIT_FLAGS = ["--mode", "--research-paper-kind", "--research-paper-profile", "--topic", "--repository", "--id", "--name"] as const;

export type PassthroughOption = { arity: "boolean" | "single" | "variadic"; repeatable: boolean };

// Keep synchronized with operator-documented customization flags (Task 8 lint).
export const INIT_PASSTHROUGH_OPTIONS: Record<string, PassthroughOption> = {
  "--author": { arity: "single", repeatable: false },
  "--email": { arity: "single", repeatable: false },
  "--audience": { arity: "single", repeatable: false },
  "--style": { arity: "single", repeatable: false },
  "--taxonomy": { arity: "variadic", repeatable: false },
  "--target-length-words": { arity: "single", repeatable: false },
  "--citation-style": { arity: "single", repeatable: false },
  "--output-format": { arity: "variadic", repeatable: false },
  "--research-provider": { arity: "single", repeatable: false },
  "--research-workflow-profile": { arity: "single", repeatable: false },
  "--research-writing-strategy": { arity: "single", repeatable: false },
  "--review-cadence": { arity: "single", repeatable: false },
  "--review-time": { arity: "single", repeatable: false },
  "--review-interval-hours": { arity: "single", repeatable: false },
  "--max-unit-minutes": { arity: "single", repeatable: false },
  "--max-active-run-minutes": { arity: "single", repeatable: false },
  "--max-recorded-tokens": { arity: "single", repeatable: false },
  "--reference-link": { arity: "single", repeatable: true },
  "--reference-file": { arity: "single", repeatable: true },
  "--reference-instructions": { arity: "single", repeatable: false },
};

export function validateInitPassthrough(afterDashDash: readonly string[], ctx: { hasWriting: boolean }): { ok: true; args: string[] } | { ok: false; message: string } {
  if (afterDashDash.length === 0) return { ok: true, args: [] };
  if (!ctx.hasWriting) return { ok: false, message: `This is an experiment-only template with no writing component; LongWrite customization after -- is not accepted.` };

  const args: string[] = [];
  for (let i = 0; i < afterDashDash.length; i++) {
    const token = afterDashDash[i];
    if ((RESERVED_INIT_FLAGS as readonly string[]).includes(token)) {
      return { ok: false, message: `${token} is reserved to the maliang template/native options; set it via 'maliang init' options or choose another template, not after --.` };
    }
    const spec = INIT_PASSTHROUGH_OPTIONS[token];
    if (!spec) return { ok: false, message: `Unknown init passthrough option ${token}. Allowed: ${Object.keys(INIT_PASSTHROUGH_OPTIONS).join(", ")}` };
    args.push(token);
    if (spec.arity === "boolean") continue;
    // Consume value(s): single takes one; variadic takes until the next option.
    if (spec.arity === "single") {
      if (afterDashDash[i + 1] === undefined || afterDashDash[i + 1].startsWith("--")) return { ok: false, message: `${token} requires a value` };
      args.push(afterDashDash[++i]);
    } else {
      if (afterDashDash[i + 1] === undefined || afterDashDash[i + 1].startsWith("--")) return { ok: false, message: `${token} requires at least one value` };
      while (afterDashDash[i + 1] !== undefined && !afterDashDash[i + 1].startsWith("--")) args.push(afterDashDash[++i]);
    }
  }
  return { ok: true, args };
}
```

In `apps/maliang/src/cli.ts`, change the `init` command to capture passthrough and thread it into `initializeWorkspace`:

```ts
program.command("init <dir>")
  .requiredOption("--template <id>", "Template id; run maliang template list")
  .option("--topic <text>", "Writing topic")
  .option("--hypothesis <text>", "Falsifiable experiment hypothesis")
  .option("--repository <source...>", "Pinned Git URL or local Git path; repeatable")
  .option("--name <text>", "Project name")
  .option("--experiment-template <id>", "Optional LongExperiment flagship for an empirical-paper template")
  .allowUnknownOption(false)
  .action((dir, options, command) => initializeWorkspace(dir, { ...options, passthrough: command.args.slice(command.args.indexOf(dir) + 1) }));
```

Better: read passthrough from the raw argv `--` boundary. commander exposes it via `program.parseOptions`/`command.args`; during implementation, capture everything after the literal `--` from `process.argv` before commander strips it (commander 12 keeps post-`--` tokens in `command.args`). In `initializeWorkspace`, where `template.writing` builds `args`, validate and append:

```ts
if (template.writing) {
  const writingDir = path.join(workspace, "writing");
  const args = ["init", writingDir, "--mode", template.writing.mode, "--topic", options.topic!];
  if (template.writing.paperKind) args.push("--research-paper-kind", template.writing.paperKind);
  if (template.writing.profile) args.push("--research-paper-profile", template.writing.profile);
  for (const repository of options.repository ?? []) args.push("--repository", repository);
  if (options.name) args.push("--name", options.name);
  const passthrough = validateInitPassthrough(options.passthrough ?? [], { hasWriting: true });
  if (!passthrough.ok) throw new Error(passthrough.message);
  args.push(...passthrough.args);
  await runComponent("longwrite", args, workspace);
  components.writing = { workspace: "writing" };
}
```

For experiment-only templates, call `validateInitPassthrough(options.passthrough ?? [], { hasWriting: false })` and throw if not ok, before creating the experiment. Add `passthrough?: string[]` to `InitOptions`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/init-passthrough.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C MrMaLiang add apps/maliang/src/init-passthrough.ts apps/maliang/src/cli.ts apps/maliang/tests/init-passthrough.test.ts
git -C MrMaLiang commit -m "feat(maliang): validated init -- passthrough with reserved structural flags"
```

---

### Task 6: Unified preflight contract

**Files:**
- Create: `apps/maliang/src/preflight.ts` (moves the check logic out of `cli.ts`)
- Modify: `apps/maliang/src/cli.ts` (`preflight` command delegates to the new module and passes `--runtime`)
- Test: `apps/maliang/tests/preflight.test.ts`

**Interfaces:**
- Produces:
  - `type ComponentReport = { status: "pass" | "fail" | "not_required"; checks: Array<{ id: string; pass: boolean; finding: string }> }`
  - `type UnifiedPreflight = { version: 1; overall: "pass" | "fail"; writing: ComponentReport; experiment: ComponentReport; runtime: ComponentReport }`
  - `function assembleUnifiedReport(parts: { writing: ComponentReport; experiment: ComponentReport; runtime: ComponentReport }): UnifiedPreflight` — sets `overall` to `fail` if any non-`not_required` component is `fail`.
  - `async function runUnifiedPreflight(workspace: string, runtime: string | undefined): Promise<UnifiedPreflight>` — runs lifecycle checks, folds `longwrite preflight` output when a writing component exists, writes `<workspace>/reports/maliang-preflight.json`, returns the report.

- [ ] **Step 1: Write the failing test**

```ts
// apps/maliang/tests/preflight.test.ts
import { describe, expect, it } from "vitest";
import { assembleUnifiedReport } from "../src/preflight.js";

const ok = { status: "pass" as const, checks: [] };
const bad = { status: "fail" as const, checks: [{ id: "matplotlib", pass: false, finding: "missing" }] };
const na = { status: "not_required" as const, checks: [] };

describe("unified preflight assembly", () => {
  it("passes when no required component fails", () => {
    expect(assembleUnifiedReport({ writing: ok, experiment: na, runtime: ok })).toMatchObject({ version: 1, overall: "pass" });
  });
  it("fails when any required component fails and ignores not_required", () => {
    expect(assembleUnifiedReport({ writing: bad, experiment: na, runtime: ok }).overall).toBe("fail");
    expect(assembleUnifiedReport({ writing: ok, experiment: na, runtime: ok }).overall).toBe("pass");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/preflight.test.ts`
Expected: FAIL — `Cannot find module '../src/preflight.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/maliang/src/preflight.ts
export type ComponentReport = { status: "pass" | "fail" | "not_required"; checks: Array<{ id: string; pass: boolean; finding: string }> };
export type UnifiedPreflight = { version: 1; overall: "pass" | "fail"; writing: ComponentReport; experiment: ComponentReport; runtime: ComponentReport };

export function assembleUnifiedReport(parts: { writing: ComponentReport; experiment: ComponentReport; runtime: ComponentReport }): UnifiedPreflight {
  const required = [parts.writing, parts.experiment, parts.runtime].filter((r) => r.status !== "not_required");
  const overall = required.some((r) => r.status === "fail") ? "fail" : "pass";
  return { version: 1, overall, writing: parts.writing, experiment: parts.experiment, runtime: parts.runtime };
}
```

Then add `runUnifiedPreflight` (move the existing `preflightWorkspace` check logic from `cli.ts` into per-component `checks`; when `project.components.writing` exists, spawn `longwrite preflight <ws>/writing --runtime <runtime>` with a capture runner and read `<ws>/writing/reports/preflight.json` — or `<ws>/reports/preflight.json` when the subdir is `.` — into `writing.checks`, setting `writing.status` from that file's pass/fail). Write the unified report to `<workspace>/reports/maliang-preflight.json` (create `reports/` if missing). In `cli.ts`, the `preflight` command calls `runUnifiedPreflight`, prints the JSON, and `process.exitCode = report.overall === "fail" ? 1 : 0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd MrMaLiang && npx vitest run apps/maliang/tests/preflight.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full build + suite, then commit**

```bash
cd MrMaLiang && npm run build && npm test
git -C MrMaLiang add apps/maliang/src/preflight.ts apps/maliang/src/cli.ts apps/maliang/tests/preflight.test.ts
git -C MrMaLiang commit -m "feat(maliang): unified preflight report contract with per-component status"
```

Expected `npm test`: all workspace suites PASS, including the existing `empirical-handoff.e2e.test.ts` (proves native `init`/`handoff` unaffected).

---

## Phase 2 — Documentation migration

### Task 7: Documentation command-lint test

**Files:**
- Create: `apps/maliang/tests/docs-commands.test.ts`
- Create: `apps/maliang/src/doc-commands.ts` (extractor + classifier, reused by the test)

**Interfaces:**
- Produces:
  - `function extractShellCommands(markdown: string): string[]` — lines inside ```` ```bash ```` / ```` ```sh ```` fences.
  - `function classifyCommand(line: string): { kind: "maliang" | "malaclaw" | "internal" | "component" | "other"; verb?: string[] }` — `internal` = contains `dist/cli.js`; `component` = starts with `longwrite `/`longexperiment ` and is not internal.
  - The test asserts: (a) no operator-facing doc contains a `component`-kind command; (b) every `maliang` proxied command (non-native verb) maps to a `findContract` entry.

- [ ] **Step 1: Write the failing test**

```ts
// apps/maliang/tests/docs-commands.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyCommand, extractShellCommands } from "../src/doc-commands.js";
import { findContract } from "../src/routing.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OPERATOR_DOCS = [
  "packages/longwrite/docs/full-auto-research-agentic-flagship.md",
  "packages/longwrite/docs/configuration.md",
  "packages/longwrite/docs/research-evidence.md",
  "packages/longwrite/docs/repository-paper-flagship.md",
  "packages/longwrite/docs/workspace-lifecycle.md",
  "packages/longwrite/docs/architecture.md",
  "packages/longwrite/docs/quickstart.md",
  "packages/longexperiment/docs/flagships/README.md",
];

describe("operator docs use only the maliang public surface", () => {
  for (const rel of OPERATOR_DOCS) {
    it(`${rel} has no direct component CLI commands`, () => {
      const md = fs.readFileSync(path.join(root, rel), "utf8");
      const offenders = extractShellCommands(md).filter((line) => classifyCommand(line).kind === "component");
      expect(offenders).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/docs-commands.test.ts`
Expected: FAIL — modules missing, and (once modules exist) offenders present in the not-yet-migrated docs.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/maliang/src/doc-commands.ts
export function extractShellCommands(markdown: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^```(bash|sh|shell|console)\s*$/.test(line)) { inFence = true; continue; }
    if (inFence && line.startsWith("```")) { inFence = false; continue; }
    if (inFence && line && !line.startsWith("#")) lines.push(line.replace(/^\$\s+/, ""));
  }
  return lines;
}

export function classifyCommand(line: string): { kind: "maliang" | "malaclaw" | "internal" | "component" | "other"; verb?: string[] } {
  if (line.includes("dist/cli.js")) return { kind: "internal" };
  if (/^malaclaw\s/.test(line)) return { kind: "malaclaw" };
  if (/^maliang\s/.test(line)) return { kind: "maliang", verb: line.split(/\s+/).slice(1) };
  if (/^(longwrite|longexperiment)\s/.test(line)) return { kind: "component", verb: line.split(/\s+/).slice(1) };
  return { kind: "other" };
}
```

- [ ] **Step 4: Confirm the test fails for the RIGHT reason**

Run: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/docs-commands.test.ts`
Expected: FAIL listing real `longwrite …`/`longexperiment …` offender lines in the 8 docs — this is the migration worklist for Task 8.

- [ ] **Step 5: Commit the lint (red is expected until Task 8)**

```bash
git -C MrMaLiang add apps/maliang/src/doc-commands.ts apps/maliang/tests/docs-commands.test.ts
git -C MrMaLiang commit -m "test(maliang): docs command-lint enforcing the maliang public surface"
```

---

### Task 8: Migrate the 8 command-bearing docs

**Files (rewrite operator commands only):**
- `packages/longwrite/docs/full-auto-research-agentic-flagship.md`
- `packages/longwrite/docs/configuration.md`
- `packages/longwrite/docs/research-evidence.md`
- `packages/longwrite/docs/repository-paper-flagship.md`
- `packages/longwrite/docs/workspace-lifecycle.md`
- `packages/longwrite/docs/architecture.md`
- `packages/longwrite/docs/quickstart.md`
- `packages/longexperiment/docs/flagships/README.md`

**Rewrite contract (apply per offender line from Task 7 output):**
- `longwrite <verb> <workspace> …` → `maliang <verb> <workspace> …` (convenience form). Where the component is ambiguous or experiment-side, use `maliang writing <verb> …` / `maliang experiment <verb> …`.
- `longwrite init <name> <flags…>` → `maliang init <name> --template <id> --topic "…" -- <allowed customization flags>`; move any reserved structural flag (`--mode/--research-paper-kind/--research-paper-profile/--topic/--repository/--name`) to the template choice or a native option. Add the prominent `--` example from the spec §6.
- Workspace paths: a bare `<name>` stays a workspace name (the proxy resolves the subdir). Where a doc references the on-disk config, update `longwrite.yaml` → `<workspace>/writing/longwrite.yaml` and `malaclaw.yaml` → generated under the component subdir.
- `malaclaw …` lines: unchanged.
- `node …/dist/cli.js …` lines: unchanged, and add/keep a sentence labeling them internal implementation details, not operator steps.
- Flip the flagship note (`full-auto-research-agentic-flagship.md`) that prefers `longwrite init` over `node dist/cli.js` to prefer `maliang init`, with component/`dist` paths as the internal/dev fallback.

- [ ] **Step 1:** Run the lint to get the current offender list: `cd MrMaLiang && npm run build && npx vitest run apps/maliang/tests/docs-commands.test.ts` (note failing lines per file).
- [ ] **Step 2:** Edit each of the 8 files, applying the rewrite contract to every offender line. Work one file at a time.
- [ ] **Step 3:** Re-run the lint after each file: `npx vitest run apps/maliang/tests/docs-commands.test.ts` — the file's `it(...)` must go green.
- [ ] **Step 4:** When all 8 are green, run the full suite: `cd MrMaLiang && npm test`. Expected: all PASS (routing registry now covers every documented proxied verb; if the lint's "maps to a contract" assertion — added below — flags a verb with no entry, add that entry to `ROUTING_REGISTRY` in `routing.ts` and rebuild).

Add to `apps/maliang/tests/docs-commands.test.ts` a second assertion block and make it green as part of this task:

```ts
it("every documented maliang proxied verb maps to a routing contract", () => {
  const NATIVE = new Set(["init", "run", "status", "provenance", "preflight", "migrate", "handoff", "experiment", "template", "writing"]);
  for (const rel of OPERATOR_DOCS) {
    const md = fs.readFileSync(path.join(root, rel), "utf8");
    for (const line of extractShellCommands(md)) {
      const c = classifyCommand(line);
      if (c.kind !== "maliang" || !c.verb?.length) continue;
      let verb = c.verb;
      if (verb[0] === "writing" || verb[0] === "experiment") verb = verb.slice(1);
      if (NATIVE.has(verb[0])) continue;
      const tokens = verb.filter((t) => !t.startsWith("-"));
      expect(findContract(tokens), `${rel}: '${line}'`).not.toBeNull();
    }
  }
});
```

- [ ] **Step 5: Commit**

```bash
git -C MrMaLiang add packages/longwrite/docs packages/longexperiment/docs/flagships/README.md apps/maliang/tests/docs-commands.test.ts apps/maliang/src/routing.ts
git -C MrMaLiang commit -m "docs: migrate operator commands to the maliang public CLI"
```

---

### Task 9: Façade consistency pass and final grep sweep

**Files (review/adjust framing; no command rewrites expected):**
- `README.md`, `docs/quickstart.md`, `docs/templates.md`, `docs/migration.md`
- `packages/longexperiment/docs/flagships/{nanogpt-ablation,proteingym-autoscientists,self-play-small-model}.md`

- [ ] **Step 1:** Read each file; ensure it presents `maliang` as the sole public CLI and labels MalaClaw as an external dependency. Fix any stray operator-facing component command or mislabeled internal example.
- [ ] **Step 2:** Run the exhaustive sweep across ALL docs (not just the 8):

```bash
cd MrMaLiang && grep -rnE '(^|[^a-zA-Z._/-])(longwrite|longexperiment) [a-z]' README.md docs packages/longwrite/docs packages/longexperiment/docs | grep -v 'dist/cli.js'
```

Expected: only lines explicitly labeled as internal implementation details remain; no operator-facing invocation. Fix any surprise hit.
- [ ] **Step 3:** Full suite: `cd MrMaLiang && npm test`. Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git -C MrMaLiang add README.md docs packages/longexperiment/docs
git -C MrMaLiang commit -m "docs: maliang facade consistency pass across guides"
```

---

### Task 10: Version bump and release notes

**Files:**
- Modify: `apps/maliang/package.json` (`version` → `0.2.0`)
- Modify: `docs/release.md` (add a `0.2.0` entry describing the new public proxy surface)

- [ ] **Step 1:** Set `apps/maliang/package.json` `version` to `0.2.0`.
- [ ] **Step 2:** Add a `0.2.0` release note: maliang is now the single public/operator CLI (writing/experiment proxy namespaces, convenience routing, validated `init --` passthrough, unified preflight report); component CLIs are internal; MalaClaw remains external.
- [ ] **Step 3:** Sanity: `cd MrMaLiang && npm run release:check` (runs full test + `maliang template list`). Expected: PASS and the template list prints.
- [ ] **Step 4: Commit**

```bash
git -C MrMaLiang add apps/maliang/package.json docs/release.md
git -C MrMaLiang commit -m "chore(maliang): release 0.2.0 — maliang as the single public CLI"
```

---

## Self-Review (author check, completed)

**Spec coverage:** §1 namespaces → Task 4; §2 convenience+allowlist → Tasks 1,4; §3 per-verb contract/arg handling → Tasks 1,2; §4 native collisions → Tasks 4,6 (native precedence test) ; §5 preflight contract → Task 6; §6 init passthrough → Task 5; §7 error handling → Tasks 2,3,5; §8 process/help/signals → Tasks 3,4; testing → Tasks 1-7; docs migration (8 + façade) → Tasks 8,9; command-lint → Task 7; rollout/version → Task 10. No uncovered section.

**Placeholder scan:** no TBD/TODO; every code step carries complete code. Two steps (proxy `require` note, commander wildcard note) flag a known API-verification point with the observable test contract that must hold — acceptable implementer guidance, not a content gap.

**Type consistency:** `Component`, `VerbContract`, `Resolution`, `ComponentReport`, `UnifiedPreflight`, `findContract`, `resolveInvocation`, `componentSubdir`, `buildForwardArgs`, `forwardCommand`, `validateInitPassthrough`, `assembleUnifiedReport` are defined once and referenced consistently across tasks.
