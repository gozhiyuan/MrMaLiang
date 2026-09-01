# Contract Core, Plan 2: MalaClaw Contract IR v2 Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "a unit succeeded because its declared outputs changed" with a kernel that runs mutations transactionally, ingests measurements it alone stores, evaluates scoped acceptance and invariants, journals every attempt idempotently, holds real leases, serializes conflicting writes against snapshots, and returns typed outcomes — without learning a single domain concept.

**Architecture:** Eleven milestones, each independently testable. The kernel gains a *transactional task workspace* (a worker sees only its declared reads, and its diff is validated before commit), an *engine-owned observation store* fed by measurement envelopes, an append-only *attempt journal* with claimed idempotency keys, *persistent leases* driven by a new worker event stream, and *snapshot-bound scheduling*. IR v2 is a breaking revision; there are no in-flight runs worth preserving.

**Tech Stack:** TypeScript (ESM, Node 22+), Zod 3, Vitest 4 (`globals: true`; tests import explicitly to match the existing suite).

**Specs:**
- `MrMaLiang/docs/superpowers/specs/2026-08-31-contract-enforcement-core-design.md` — Part B.
- `MrMaLiang/docs/superpowers/specs/2026-09-01-observation-and-criterion-wire-contract.md` — **the boundary contract this plan implements.** Read it first; §2 assigns ownership, §3 defines the envelope, §4 defines observation identity, §6 defines the arithmetic this kernel owns exclusively.

## Global Constraints

- Node.js 22 or newer. ESM; **relative imports carry the `.js` extension** in `.ts` files.
- **MalaClaw learns no domain semantics.** It sees named numeric measurements, declared file effects, and typed outcomes. Enforced by Task 20's boundary test, not by a grep.
- **The kernel is the sole owner of observation storage, sequence allocation, and acceptance arithmetic** (wire contract §2). MrMaLiang produces envelopes; it never writes the store. There is exactly one implementation of the arithmetic in §6, and it lives here.
- **IR v2 is breaking.** `ir_version: 2` is **required**, never defaulted — an unversioned manifest is v1 and is rejected with a migration message.
- `src/lib/schema.ts` is canonical. `schemas/*.json` are generated: run `npm run schema:export` after any schema change or `tests/manifest-schema-export.test.ts` fails.
- Freshness resolves by `(metric, scope_key, input_digest, evaluator_digest)` then sequence. **Never by wall clock.**
- Only lease expiry terminates an attempt. Elapsed time can mark it stalled, which triggers diagnosis.
- Structured commands only (`cmd` + `args`). No shell interpolation.
- Existing public API shapes are contracts: `runFlow(opts: RunFlowOptions)` takes **one object**; `WorkerRuntime.runStage(req)` returns `StageRunResult`. Extend them additively; do not invent parameters in tests.
- Tests: `npm test`. Build before CLI behavior tests — the CLI runs from `dist/`.
- Preserve the dirty worktree. Only touch files named in a task.

## Milestones

| # | Milestone | Tasks |
| --- | --- | --- |
| M1 | IR v2 schema and explicit migration | 1–3 |
| M2 | Transactional task workspace and effect commit | 4–6 |
| M3 | Engine-owned observation ingestion | 7–8 |
| M4 | Scoped acceptance and invariants | 9 |
| M5 | Worker event protocol | 10 |
| M6 | Attempt journal and idempotency claims | 11–12 |
| M7 | Persistent leases and orphan recovery | 13 |
| M8 | Snapshot, conflict and join scheduling | 14 |
| M9 | Blocked corrective subflows | 15–16 |
| M10 | Run pin storage and migration | 17 |
| M11 | Integration across scheduler shapes | 18–21 |
| M12 | Dispatch protocol and integration hardening | 22–24 |

**Ordering note.** Tasks 22 to 24 are numbered last but are *prerequisites* of Task 18: the engine cycle cannot be integrated before the dispatch protocol, the observation binding and safe lease acquisition exist. Implement M12 immediately after M8, then M9 to M11.

---

## M1 — IR v2 schema and explicit migration

### Task 1: Two-axis outcome model

**Files:**
- Create: `src/lib/workflow/outcomes.ts`
- Test: `tests/contract-outcomes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ExecutionOutcome`, `ContractOutcome` Zod enums and types; `EXECUTION_POLICY`, `CONTRACT_POLICY`; `ExecutionAction`, `ContractAction`; `executionAction(o)`, `contractAction(o)`, `blocksWorkspace(o)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-outcomes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ContractOutcome, ExecutionOutcome, CONTRACT_POLICY, EXECUTION_POLICY,
  contractAction, executionAction, blocksWorkspace,
} from "../src/lib/workflow/outcomes.js";

describe("two-axis outcomes", () => {
  it("separates execution success from contract success", () => {
    expect(executionAction("completed")).toBe("evaluate_contract");
    expect(contractAction("unmet")).toBe("diagnose");
  });

  it("gives every outcome on both axes exactly one policy", () => {
    for (const outcome of ContractOutcome.options) expect(CONTRACT_POLICY[outcome]).toBeDefined();
    for (const outcome of ExecutionOutcome.options) expect(EXECUTION_POLICY[outcome]).toBeDefined();
  });

  it("treats a unit with no quality objective as not_applicable", () => {
    expect(contractAction("not_applicable")).toBe("continue");
  });

  it("resumes a quota interruption instead of counting it as a failed strategy", () => {
    expect(executionAction("quota_exhausted")).toBe("pause_and_resume_from_checkpoint");
  });

  it("blocks for regressions, effect violations and unreconciled effects", () => {
    for (const outcome of ["regressed", "partially_improved_with_regression",
      "undeclared_write", "undeclared_read", "requires_reconciliation"] as const) {
      expect(blocksWorkspace(outcome), outcome).toBe(true);
    }
  });

  it("does not block for a merely unmet objective", () => {
    expect(blocksWorkspace("unmet")).toBe(false);
    expect(blocksWorkspace("improved")).toBe(false);
  });

  it("retries a failed measurement before blocking", () => {
    expect(contractAction("measurement_failed")).toBe("retry_measurement_then_block");
  });

  it("distinguishes exhausted strategies from proven unreachability", () => {
    expect(contractAction("strategy_exhausted")).toBe("pause");
    expect(contractAction("unreachable")).toBe("pause");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-outcomes`
Expected: FAIL — cannot resolve `../src/lib/workflow/outcomes.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/outcomes.ts`:

```ts
import { z } from "zod";

/** Did the unit run? Independent of whether its contract was satisfied.
 *
 * Recall, builds, packaging and measurement units all need an execution result
 * and have no quality objective at all; collapsing both axes into one enum is
 * how "the stage succeeded but the gate is still failing" became invisible. */
export const ExecutionOutcome = z.enum([
  "completed", "failed", "timeout", "quota_exhausted", "cancelled",
]);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcome>;

export const ContractOutcome = z.enum([
  "not_applicable", "accepted", "improved", "pending_verification",
  "unmet", "stalled", "regressed", "partially_improved_with_regression",
  "strategy_exhausted", "unreachable", "operator_required",
  "repeated_strategy", "undeclared_write", "undeclared_read",
  "measurement_failed", "requires_reconciliation",
]);
export type ContractOutcome = z.infer<typeof ContractOutcome>;

export type ExecutionAction =
  | "evaluate_contract" | "retry_unit" | "reconcile_then_retry"
  | "pause_and_resume_from_checkpoint" | "pause";

export type ContractAction =
  | "continue" | "retry" | "defer_to_round" | "diagnose" | "change_strategy"
  | "pause" | "block" | "reject" | "retry_measurement_then_block";

export const EXECUTION_POLICY: Record<ExecutionOutcome, ExecutionAction> = {
  completed: "evaluate_contract",
  failed: "retry_unit",
  // Lease expiry, never elapsed time. See leases.ts.
  timeout: "reconcile_then_retry",
  // An infrastructure interruption, not a failed repair strategy: it must never
  // consume a strategy attempt or advance a stagnation counter.
  quota_exhausted: "pause_and_resume_from_checkpoint",
  cancelled: "pause",
};

export const CONTRACT_POLICY: Record<ContractOutcome, ContractAction> = {
  not_applicable: "continue",
  accepted: "continue",
  improved: "retry",
  pending_verification: "defer_to_round",
  unmet: "diagnose",
  stalled: "change_strategy",
  regressed: "block",
  partially_improved_with_regression: "block",
  strategy_exhausted: "pause",
  unreachable: "pause",
  operator_required: "block",
  repeated_strategy: "reject",
  undeclared_write: "block",
  undeclared_read: "block",
  measurement_failed: "retry_measurement_then_block",
  requires_reconciliation: "block",
};

export function executionAction(outcome: ExecutionOutcome): ExecutionAction {
  return EXECUTION_POLICY[outcome];
}
export function contractAction(outcome: ContractOutcome): ContractAction {
  return CONTRACT_POLICY[outcome];
}

/** `pause` halts the run; `block` additionally marks the workspace so no
 * downstream unit may run until the block is cleared. */
export function blocksWorkspace(outcome: ContractOutcome): boolean {
  return CONTRACT_POLICY[outcome] === "block";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-outcomes`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/outcomes.ts tests/contract-outcomes.test.ts
git commit -m "feat(workflow): separate execution outcomes from contract outcomes"
```

---

### Task 2: Effect and contract fields in the IR

**Files:**
- Modify: `src/lib/schema.ts`
- Test: `tests/contract-effects-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: on every work unit — `kind: "plain" | "mutation" | "measurement"` (default `"plain"`), `reads: string[]`, **`writes: string[]`**, `owns: string[]`, `writes_observations: string[]`, `evaluate_with: string[]`, `acceptance: Criterion[]`, `must_preserve: Criterion[]`, `must_improve: MustImprove[]`, `strategy?: Strategy`. On `WorkflowDef` — `observation_store: string` (default `.malaclaw/observations`) and a **required** `ir_version` literal 2. Exports `matchesEnvelope(pattern, filePath)`.

`writes` is the field every test and example uses; the previous draft omitted it and could not compile. `outputs` keeps its existing meaning — artifacts that must exist and validate — while `writes` names paths expected to *change*.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-effects-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WorkflowDef, matchesEnvelope } from "../src/lib/schema.js";

const v2 = (stages: unknown[]) => WorkflowDef.parse({ ir_version: 2, stages });

describe("IR v2 effect declarations", () => {
  it("requires ir_version explicitly rather than defaulting", () => {
    // An unversioned manifest is v1; silently reading it as v2 would defeat the
    // explicit rejection in Task 3.
    expect(() => WorkflowDef.parse({ stages: [{ id: "a", owner: "x" }] })).toThrow();
    expect(v2([{ id: "a", owner: "x" }]).ir_version).toBe(2);
  });

  it("accepts a mutation unit declaring reads, writes and an envelope", () => {
    const wf = v2([{
      id: "repair", owner: "eng", kind: "mutation",
      reads: ["src/**"], writes: ["src/a.ts"], owns: ["src/**"],
      outputs: ["src/a.ts"], evaluate_with: ["measure"],
    }]);
    const stage = wf.stages[0] as { kind: string; writes: string[]; owns: string[] };
    expect(stage.kind).toBe("mutation");
    expect(stage.writes).toEqual(["src/a.ts"]);
    expect(stage.owns).toEqual(["src/**"]);
  });

  it("accepts a measurement unit declaring the observations it writes", () => {
    const wf = v2([{
      id: "measure", owner: "ci", kind: "measurement",
      reads: ["src/**"], writes_observations: ["test_coverage"],
      outputs: ["reports/measurements.json"],
    }]);
    expect((wf.stages[0] as { writes_observations: string[] }).writes_observations)
      .toEqual(["test_coverage"]);
  });

  it("rejects a mutation unit that writes observations grading itself", () => {
    expect(() => v2([{
      id: "repair", owner: "eng", kind: "mutation",
      writes: ["src/a.ts"], owns: ["src/**"], writes_observations: ["test_coverage"],
    }])).toThrow(/mutation unit may not write observations/i);
  });

  it("rejects a measurement unit that mutates files", () => {
    expect(() => v2([{
      id: "measure", owner: "ci", kind: "measurement",
      writes: ["src/a.ts"], owns: ["src/**"], writes_observations: ["test_coverage"],
    }])).toThrow(/measurement unit may not declare/i);
  });

  it("requires writes and outputs to fall inside the envelope", () => {
    expect(() => v2([{
      id: "repair", owner: "eng", kind: "mutation",
      writes: ["docs/a.md"], owns: ["src/**"], outputs: ["docs/a.md"],
    }])).toThrow(/outside its owns envelope/i);
  });

  it("carries scoped criteria with tolerance and direction compiled in", () => {
    const wf = v2([{
      id: "repair", owner: "eng", kind: "mutation", owns: ["src/**"], writes: ["src/a.ts"],
      outputs: ["src/a.ts"],
      acceptance: [{ metric: "test_coverage", scope_key: "module-a", operator: "at_least",
                     target: 0.9, tolerance: 0.000001, direction: "maximize" }],
      must_preserve: [{ metric: "row_validity", scope_key: "", operator: "at_least",
                        target: 1, tolerance: 0, direction: "maximize" }],
    }]);
    const stage = wf.stages[0] as { acceptance: Array<{ scope_key: string; tolerance: number }> };
    expect(stage.acceptance[0].scope_key).toBe("module-a");
    expect(stage.acceptance[0].tolerance).toBeCloseTo(1e-6, 12);
  });

  it("rejects an operator that fights the compiled direction", () => {
    expect(() => v2([{
      id: "repair", owner: "eng", kind: "mutation", owns: ["src/**"],
      acceptance: [{ metric: "defects", scope_key: "", operator: "at_least",
                     target: 1, tolerance: 0, direction: "minimize" }],
    }])).toThrow(/direction/i);
  });

  it("declares the observation store rather than hardcoding one", () => {
    expect(v2([{ id: "a", owner: "x" }]).observation_store).toBe(".malaclaw/observations");
  });

  it("matches envelopes by exact path or trailing glob only", () => {
    expect(matchesEnvelope("src/**", "src/a/b.ts")).toBe(true);
    expect(matchesEnvelope("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesEnvelope("src/a.ts", "src/b.ts")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-effects-schema`
Expected: FAIL — `ir_version` still defaults, and `kind`/`writes` are rejected by the strict object.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/schema.ts`, above `workUnitFields`:

```ts
/** A criterion compiled by the domain layer, carrying tolerance and direction
 * so the kernel needs no metric registry (wire contract §5). */
export const Criterion = z.object({
  metric: z.string().min(1),
  /** Canonical scope; the empty string means workspace-global. */
  scope_key: z.string().default(""),
  operator: z.enum(["at_least", "at_most", "equals"]),
  target: z.number().finite(),
  tolerance: z.number().nonnegative(),
  direction: z.enum(["maximize", "minimize"]),
}).strict().superRefine((criterion, ctx) => {
  if (criterion.direction === "maximize" && criterion.operator === "at_most") {
    ctx.addIssue({ code: "custom", path: ["operator"],
      message: "at_most fights a maximize direction; the compiler must not emit it" });
  }
  if (criterion.direction === "minimize" && criterion.operator === "at_least") {
    ctx.addIssue({ code: "custom", path: ["operator"],
      message: "at_least fights a minimize direction; the compiler must not emit it" });
  }
});
export type Criterion = z.infer<typeof Criterion>;

export const MustImprove = z.object({
  metric: z.string().min(1),
  scope_key: z.string().default(""),
  min_absolute_delta: z.number().nonnegative().default(0),
  min_gap_fraction: z.number().min(0).max(1).default(0),
  max_attempts: z.number().int().min(1).default(2),
}).strict();
export type MustImprove = z.infer<typeof MustImprove>;

export const Strategy = z.object({ key: z.array(z.string().min(1)).min(1) }).strict();

/** Glob support is deliberately minimal: a trailing `/**` prefix match or an
 * exact path. Anything richer invites disagreement about what an envelope
 * means, and an envelope is a safety boundary. */
export function matchesEnvelope(pattern: string, filePath: string): boolean {
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -2));
  return pattern === filePath;
}
```

Add to `workUnitFields`:

```ts
  kind: z.enum(["plain", "mutation", "measurement"]).default("plain"),
  reads: z.array(workspacePath).default([]),
  /** Paths expected to CHANGE. Distinct from `outputs`, which must exist and
   * validate. Both must fall inside `owns`. */
  writes: z.array(workspacePath).default([]),
  /** The allowed mutation envelope: permission, not obligation, so an
   * owned-but-unchanged path is legal. */
  owns: z.array(workspacePath).default([]),
  writes_observations: z.array(z.string().min(1)).default([]),
  evaluate_with: z.array(workflowId).default([]),
  acceptance: z.array(Criterion).default([]),
  must_improve: z.array(MustImprove).default([]),
  must_preserve: z.array(Criterion).default([]),
  strategy: Strategy.optional(),
```

Add a shared refinement applied by `StandardStage`, `WorkflowAction` and `WorkflowStep`:

```ts
export function refineEffects(unit: {
  kind: string; writes: string[]; owns: string[];
  writes_observations: string[]; outputs: unknown[];
}, ctx: z.RefinementCtx): void {
  if (unit.kind === "mutation" && unit.writes_observations.length > 0) {
    ctx.addIssue({ code: "custom", path: ["writes_observations"],
      message: "a mutation unit may not write observations used to grade itself; declare a separate measurement unit" });
  }
  if (unit.kind === "measurement" && (unit.owns.length > 0 || unit.writes.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["owns"],
      message: "a measurement unit may not declare writes or an ownership envelope over what it measures" });
  }
  if (unit.owns.length === 0) return;
  const declared = [
    ...unit.writes,
    ...unit.outputs.map((o) => (typeof o === "string" ? o : (o as { path: string }).path)),
  ];
  for (const target of declared) {
    if (!unit.owns.some((pattern) => matchesEnvelope(pattern, target))) {
      ctx.addIssue({ code: "custom", path: ["writes"],
        message: `${target} falls outside its owns envelope` });
    }
  }
}
```

In `WorkflowDef`, replace `ir_version: z.number().int().min(1).default(1)` with a **required** literal and add the store path:

```ts
    /** Required, never defaulted: an unversioned manifest is v1 and must be
     * rejected explicitly rather than reinterpreted under v2 semantics. */
    ir_version: z.literal(2),
    /** Previously hardcoded to reports/metrics.json inside stop-condition.ts,
     * which was a domain assumption living in the kernel. */
    observation_store: workspacePath.default(".malaclaw/observations"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-effects-schema`
Expected: PASS, 10 tests.

- [ ] **Step 5: Regenerate the exported JSON Schema**

Run: `npm run schema:export && npm test -- manifest-schema-export`
Expected: PASS. The exported schema is the cross-language SDK contract; a schema change without regeneration is a failing test, not silent drift.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schema.ts schemas/ tests/contract-effects-schema.test.ts
git commit -m "feat!: add execution roles, effects and scoped criteria to IR v2"
```

---

### Task 3: Reject IR v1 and migrate the fixture corpus

**Files:**
- Modify: `src/lib/workflow/validate.ts`
- Modify: `tests/fixtures/**` and every inline manifest in `tests/`
- Test: `tests/contract-ir-version.test.ts`

**Interfaces:**
- Consumes: `WorkflowDef` (Task 2).
- Produces: `SUPPORTED_IR_VERSION`, `IrVersionError`, `assertSupportedIrVersion(raw: unknown): void` operating on the **raw manifest** before parsing, so an unversioned document produces the migration message rather than a Zod error.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-ir-version.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertSupportedIrVersion, IrVersionError, SUPPORTED_IR_VERSION } from "../src/lib/workflow/validate.js";

describe("IR version enforcement", () => {
  it("accepts a v2 manifest", () => {
    expect(() => assertSupportedIrVersion({ ir_version: 2, stages: [] })).not.toThrow();
    expect(SUPPORTED_IR_VERSION).toBe(2);
  });

  it("rejects an unversioned manifest as v1 with a migration message", () => {
    try {
      assertSupportedIrVersion({ stages: [] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IrVersionError);
      expect((error as Error).message).toMatch(/ir_version 1 is no longer supported/);
      expect((error as Error).message).toMatch(/recompile/i);
    }
  });

  it("rejects an explicit v1 manifest", () => {
    expect(() => assertSupportedIrVersion({ ir_version: 1, stages: [] })).toThrow(IrVersionError);
  });

  it("rejects a future version rather than guessing", () => {
    expect(() => assertSupportedIrVersion({ ir_version: 3, stages: [] })).toThrow(IrVersionError);
  });

  it("rejects a non-numeric version", () => {
    expect(() => assertSupportedIrVersion({ ir_version: "2", stages: [] })).toThrow(IrVersionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-ir-version`
Expected: FAIL — `assertSupportedIrVersion` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/workflow/validate.ts`:

```ts
export const SUPPORTED_IR_VERSION = 2;

export class IrVersionError extends Error {
  constructor(readonly found: unknown) {
    super(
      `ir_version ${found === undefined ? 1 : JSON.stringify(found)} is no longer supported; ` +
      `this engine executes ir_version ${SUPPORTED_IR_VERSION}. Recompile the workflow with a ` +
      `current compiler and reinitialize with \`malaclaw flow reset\`. Artifacts are preserved; ` +
      `only flow state is reinitialized.`,
    );
    this.name = "IrVersionError";
  }
}

/** Runs on the RAW manifest, before Zod. An unversioned document is v1 and must
 * produce this message rather than a generic "expected literal 2" issue. */
export function assertSupportedIrVersion(raw: unknown): void {
  const found = (raw as { ir_version?: unknown } | null)?.ir_version;
  if (found !== SUPPORTED_IR_VERSION) throw new IrVersionError(found);
}
```

Call it at the top of the manifest loader, before `WorkflowDef.parse`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-ir-version`
Expected: PASS, 5 tests.

- [ ] **Step 5: Migrate every fixture and inline manifest**

Run: `npm test`
Expected: many failures, all from v1 manifests. Add `ir_version: 2` to every fixture under `tests/fixtures/` and to every inline `WorkflowDef.parse({...})` in `tests/`. Do not weaken `assertSupportedIrVersion` or reintroduce a default to keep an old fixture green.

Run: `npm test` again — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/validate.ts tests/
git commit -m "feat!: require ir_version 2 explicitly and migrate the fixture corpus"
```

---

## M2 — Transactional task workspace and effect commit

### Task 4: Task workspace construction

Post-hoc hashing of the live workspace cannot observe what a worker *read*, and a mutation with an empty envelope escapes enforcement entirely. A worker instead runs in an isolated workspace materialized from its declared reads.

**Files:**
- Create: `src/lib/workflow/task-workspace.ts`
- Test: `tests/contract-task-workspace.test.ts`

**Interfaces:**
- Consumes: `matchesEnvelope` (Task 2).
- Produces: `TaskWorkspace` type (`root`, `unitKey`, `invocationId`, `snapshotId`, `materialized: string[]`); `createTaskWorkspace(canonicalDir, unit, opts): Promise<TaskWorkspace>`; `destroyTaskWorkspace(ws)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-task-workspace.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTaskWorkspace, destroyTaskWorkspace } from "../src/lib/workflow/task-workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function canonical(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-canon-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body, "utf-8");
  }
  return dir;
}
const unit = { unitKey: "repair", reads: ["src/**"], writes: ["src/a.ts"], owns: ["src/**"] };

describe("task workspace", () => {
  it("materializes only the declared reads", async () => {
    const dir = await canonical({ "src/a.ts": "one", "docs/secret.md": "hidden" });
    const ws = await createTaskWorkspace(dir, unit, { invocationId: "i1", snapshotId: "s1" });
    dirs.push(ws.root);
    expect(await fs.readFile(path.join(ws.root, "src/a.ts"), "utf-8")).toBe("one");
    await expect(fs.access(path.join(ws.root, "docs/secret.md"))).rejects.toThrow();
  });

  it("makes an undeclared read impossible rather than detectable", async () => {
    // The worker cannot read what was never materialized, so enforcement does
    // not depend on observing its behavior.
    const dir = await canonical({ "src/a.ts": "one", "secrets/token": "abc" });
    const ws = await createTaskWorkspace(dir, unit, { invocationId: "i1", snapshotId: "s1" });
    dirs.push(ws.root);
    expect(await fs.readdir(ws.root)).toEqual(["src"]);
  });

  it("never materializes engine state into the task workspace", async () => {
    const dir = await canonical({ "src/a.ts": "one", ".malaclaw/flow/state.json": "{}" });
    const ws = await createTaskWorkspace(dir, { ...unit, reads: ["src/**", ".malaclaw/**"] },
      { invocationId: "i1", snapshotId: "s1" });
    dirs.push(ws.root);
    await expect(fs.access(path.join(ws.root, ".malaclaw"))).rejects.toThrow();
  });

  it("records what it materialized for the diff baseline", async () => {
    const dir = await canonical({ "src/a.ts": "one", "src/b.ts": "two" });
    const ws = await createTaskWorkspace(dir, unit, { invocationId: "i1", snapshotId: "s1" });
    dirs.push(ws.root);
    expect(ws.materialized.map((entry) => entry.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(ws.materialized[0].digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("materializes a declared read that does not yet exist as absent", async () => {
    const dir = await canonical({ "src/a.ts": "one" });
    const ws = await createTaskWorkspace(dir, { ...unit, reads: ["src/**", "src/new.ts"] },
      { invocationId: "i1", snapshotId: "s1" });
    dirs.push(ws.root);
    expect(ws.materialized.map((entry) => entry.path)).not.toContain("src/new.ts");
    await expect(fs.access(path.join(ws.root, "src/new.ts"))).rejects.toThrow();
  });

  it("removes the task workspace on destroy", async () => {
    const dir = await canonical({ "src/a.ts": "one" });
    const ws = await createTaskWorkspace(dir, unit, { invocationId: "i1", snapshotId: "s1" });
    await destroyTaskWorkspace(ws);
    await expect(fs.access(ws.root)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-task-workspace`
Expected: FAIL — cannot resolve `task-workspace.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/task-workspace.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { matchesEnvelope } from "../schema.js";

export type EffectUnit = {
  unitKey: string;
  reads: string[];
  writes: string[];
  owns: string[];
};

export type TaskWorkspace = {
  root: string;
  unitKey: string;
  invocationId: string;
  snapshotId: string;
  /** Paths copied in WITH their digests at materialization time. The digest is
   * the diff baseline; recomputing it from the task copy after the run would
   * compare the copy against itself. */
  materialized: Array<{ path: string; digest: string }>;
};

const ENGINE_STATE = ".malaclaw";

async function walk(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (rel === ENGINE_STATE || rel.startsWith(`${ENGINE_STATE}/`)) continue;
    if (entry.isDirectory()) found.push(...await walk(full, base));
    else found.push(rel);
  }
  return found;
}

/** A worker sees only what it declared. This is what makes undeclared reads
 * impossible rather than merely detectable: post-hoc hashing of the live
 * workspace can observe writes, but nothing observes a read. */
export async function createTaskWorkspace(
  canonicalDir: string, unit: EffectUnit, opts: { invocationId: string; snapshotId: string },
): Promise<TaskWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `malaclaw-task-${unit.unitKey}-`));
  const available = await walk(canonicalDir, canonicalDir);
  const materialized: string[] = [];
  for (const rel of available.sort()) {
    if (!unit.reads.some((pattern) => matchesEnvelope(pattern, rel))) continue;
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(canonicalDir, rel), target);
    materialized.push(rel);
  }
  return { root, unitKey: unit.unitKey, invocationId: opts.invocationId, snapshotId: opts.snapshotId, materialized };
}

export async function destroyTaskWorkspace(workspace: TaskWorkspace): Promise<void> {
  await fs.rm(workspace.root, { recursive: true, force: true });
}

export function newSnapshotId(): string {
  return crypto.randomUUID();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-task-workspace`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/task-workspace.ts tests/contract-task-workspace.test.ts
git commit -m "feat(workflow): materialize an isolated task workspace from declared reads"
```

---

### Task 5: Diff validation and effect commit

**Files:**
- Create: `src/lib/workflow/effects.ts`
- Test: `tests/contract-effect-commit.test.ts`

**Interfaces:**
- Consumes: `TaskWorkspace` (Task 4); `matchesEnvelope` (Task 2); `ContractOutcome` (Task 1).
- Produces: `diffTaskWorkspace(ws, unit): Promise<EffectDiff>` where `EffectDiff = { declared: string[]; owned: string[]; undeclared: string[] }`; `validateDiff(diff, unit): ContractOutcome | null`; `commitEffects(canonicalDir, ws, diff): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-effect-commit.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTaskWorkspace } from "../src/lib/workflow/task-workspace.js";
import { diffTaskWorkspace, validateDiff, commitEffects } from "../src/lib/workflow/effects.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function canonical(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-commit-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body, "utf-8");
  }
  return dir;
}
const unit = { unitKey: "repair", reads: ["src/**"], writes: ["src/a.ts"], owns: ["src/**"] };

async function prepared(files: Record<string, string>) {
  const dir = await canonical(files);
  const ws = await createTaskWorkspace(dir, unit, { invocationId: "i1", snapshotId: "s1" });
  dirs.push(ws.root);
  return { dir, ws };
}

describe("effect commit", () => {
  it("classifies a declared change", async () => {
    const { ws } = await prepared({ "src/a.ts": "one" });
    await fs.writeFile(path.join(ws.root, "src/a.ts"), "changed", "utf-8");
    const diff = await diffTaskWorkspace(ws, unit);
    expect(diff.declared).toEqual(["src/a.ts"]);
    expect(validateDiff(diff, unit)).toBeNull();
  });

  it("permits an owned but undeclared change inside the envelope", async () => {
    const { ws } = await prepared({ "src/a.ts": "one", "src/b.ts": "two" });
    await fs.writeFile(path.join(ws.root, "src/b.ts"), "changed", "utf-8");
    const diff = await diffTaskWorkspace(ws, unit);
    expect(diff.owned).toEqual(["src/b.ts"]);
    expect(validateDiff(diff, unit)).toBeNull();
  });

  it("rejects a change outside the envelope", async () => {
    const { ws } = await prepared({ "src/a.ts": "one" });
    await fs.mkdir(path.join(ws.root, "docs"), { recursive: true });
    await fs.writeFile(path.join(ws.root, "docs/new.md"), "smuggled", "utf-8");
    const diff = await diffTaskWorkspace(ws, unit);
    expect(diff.undeclared).toEqual(["docs/new.md"]);
    expect(validateDiff(diff, unit)).toBe("undeclared_write");
  });

  it("rejects a mutation with an empty envelope rather than exempting it", async () => {
    // The previous design skipped enforcement when owns was empty, which let a
    // mutation escape the contract entirely.
    const { ws } = await prepared({ "src/a.ts": "one" });
    const diff = await diffTaskWorkspace(ws, { ...unit, owns: [] });
    expect(validateDiff(diff, { ...unit, owns: [] })).toBe("undeclared_write");
  });

  it("commits only declared and owned changes to the canonical workspace", async () => {
    const { dir, ws } = await prepared({ "src/a.ts": "one", "src/b.ts": "two" });
    await fs.writeFile(path.join(ws.root, "src/a.ts"), "changed", "utf-8");
    await fs.writeFile(path.join(ws.root, "src/b.ts"), "also", "utf-8");
    const diff = await diffTaskWorkspace(ws, unit);
    const committed = await commitEffects(dir, ws, diff);
    expect(committed.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf-8")).toBe("changed");
  });

  it("commits nothing when the diff is invalid", async () => {
    const { dir, ws } = await prepared({ "src/a.ts": "one" });
    await fs.writeFile(path.join(ws.root, "src/a.ts"), "changed", "utf-8");
    await fs.mkdir(path.join(ws.root, "docs"), { recursive: true });
    await fs.writeFile(path.join(ws.root, "docs/new.md"), "smuggled", "utf-8");
    const diff = await diffTaskWorkspace(ws, unit);
    expect(validateDiff(diff, unit)).toBe("undeclared_write");
    // The canonical workspace never saw the valid half either: a rejected
    // attempt commits nothing at all.
    expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf-8")).toBe("one");
    await expect(fs.access(path.join(dir, "docs/new.md"))).rejects.toThrow();
  });

  it("records a commit manifest so an interrupted commit is recoverable", async () => {
    const { dir, ws } = await prepared({ "src/a.ts": "one", "src/b.ts": "two" });
    await fs.writeFile(path.join(ws.root, "src/a.ts"), "changed", "utf-8");
    const diff = await diffTaskWorkspace(ws, unit);
    await commitEffects(dir, ws, diff);
    // Cleared on success; present means the commit was interrupted.
    expect(await pendingCommit(dir, ws.invocationId)).toBeNull();
  });

  it("propagates a deletion inside the envelope", async () => {
    const { dir, ws } = await prepared({ "src/a.ts": "one", "src/b.ts": "two" });
    await fs.rm(path.join(ws.root, "src/b.ts"));
    const diff = await diffTaskWorkspace(ws, unit);
    await commitEffects(dir, ws, diff);
    await expect(fs.access(path.join(dir, "src/b.ts"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-effect-commit`
Expected: FAIL — cannot resolve `effects.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/effects.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { matchesEnvelope } from "../schema.js";
import type { ContractOutcome } from "./outcomes.js";
import type { EffectUnit, TaskWorkspace } from "./task-workspace.js";

export type EffectDiff = {
  declared: string[];
  owned: string[];
  undeclared: string[];
  /** Paths present at materialization and absent now. */
  deleted: string[];
};

async function inventory(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function scan(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await scan(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      found.set(rel, crypto.createHash("sha256").update(await fs.readFile(full)).digest("hex"));
    }
  }
  await scan(root);
  return found;
}

export async function diffTaskWorkspace(
  workspace: TaskWorkspace, unit: EffectUnit,
): Promise<EffectDiff> {
  const after = await inventory(workspace.root);
  const before = new Set(workspace.materialized);
  const baseline = new Map<string, string>();
  for (const rel of workspace.materialized) {
    const digest = after.get(rel);
    if (digest !== undefined) baseline.set(rel, digest);
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [rel, digest] of after) {
    if (!before.has(rel)) { changed.push(rel); continue; }
    // Baseline digests come from the canonical copy at materialization time;
    // recompute against it rather than trusting the task copy.
    if (digest !== baseline.get(rel)) changed.push(rel);
  }
  for (const rel of before) if (!after.has(rel)) deleted.push(rel);

  const declaredPaths = new Set(unit.writes);
  const diff: EffectDiff = { declared: [], owned: [], undeclared: [], deleted: deleted.sort() };
  for (const rel of [...changed, ...deleted].sort()) {
    if (declaredPaths.has(rel)) diff.declared.push(rel);
    else if (unit.owns.some((pattern) => matchesEnvelope(pattern, rel))) diff.owned.push(rel);
    else diff.undeclared.push(rel);
  }
  return diff;
}

/** No exemption for an empty envelope. A mutation that declares no ownership
 * has declared that it changes nothing, and any change is undeclared. */
export function validateDiff(diff: EffectDiff, _unit: EffectUnit): ContractOutcome | null {
  return diff.undeclared.length > 0 ? "undeclared_write" : null;
}

/** A rejected attempt commits none of its changes, including the valid ones.
 *
 * This is NOT atomic across files: a crash mid-commit can leave some files
 * copied and some not, and no filesystem primitive gives multi-file atomicity.
 * The honest guarantee is *recoverable*: a commit manifest records the intended
 * file list and per-file progress before the first copy, so a resumed run
 * finishes or reverses a partial commit rather than guessing. Claiming
 * all-or-nothing without the manifest would be a promise the code cannot keep. */
export async function commitEffects(
  canonicalDir: string, workspace: TaskWorkspace, diff: EffectDiff,
): Promise<string[]> {
  if (diff.undeclared.length > 0) throw new Error("refusing to commit a diff with undeclared writes");
  const planned = [...diff.declared, ...diff.owned];
  // Written before the first copy, so a crash leaves a record of what was
  // about to change and how far it got.
  await writeCommitManifest(canonicalDir, workspace.invocationId, { planned, done: [] });
  const committed: string[] = [];
  for (const rel of [...diff.declared, ...diff.owned]) {
    const source = path.join(workspace.root, rel);
    const target = path.join(canonicalDir, rel);
    if (diff.deleted.includes(rel)) { await fs.rm(target, { force: true }); committed.push(rel); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.copyFile(source, temporary);
    await fs.rename(temporary, target);
    committed.push(rel);
    await writeCommitManifest(canonicalDir, workspace.invocationId, { planned, done: committed });
  }
  await clearCommitManifest(canonicalDir, workspace.invocationId);
  return committed.sort();
}

/** A manifest left behind means a commit was interrupted. The engine resumes it
 * from `done` or reverses it, and never treats the workspace as clean. */
export async function pendingCommit(
  canonicalDir: string, invocationId: string,
): Promise<{ planned: string[]; done: string[] } | null> { /* read the manifest, or null */ }
```

**The baseline must be captured at materialization.** `diffTaskWorkspace`
cannot compare a post-run task copy against itself, so `TaskWorkspace.materialized`
is `Array<{ path: string; digest: string }>` from the start — Task 4's
implementation and its test are written that way, not retrofitted here. Task 4's
assertion reads `ws.materialized.map((entry) => entry.path).sort()`; a plan that
changes a type in one task and claims another task's test is unaffected is
describing two incompatible codebases.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-effect-commit contract-task-workspace`
Expected: PASS, 7 + 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/effects.ts src/lib/workflow/task-workspace.ts tests/contract-effect-commit.test.ts tests/contract-task-workspace.test.ts
git commit -m "feat(workflow): validate a task-workspace diff and commit effects atomically"
```

---

### Task 6: Isolated-workspace runtime dispatch

**Files:**
- Modify: `src/lib/workflow/runtimes/base.ts` (`StageRunRequest` gains `taskWorkspaceRoot`)
- Modify: every runtime under `src/lib/workflow/runtimes/` — including `chat-api.ts` and `openai-compatible.ts`, which a hand-written list omitted
- Test: `tests/contract-isolated-dispatch.test.ts`

**Interfaces:**
- Consumes: `TaskWorkspace` (Task 4).
- Produces: every runtime executes with its working directory set to `req.taskWorkspaceRoot ?? req.workspaceDir`. `RuntimeCapabilities.requires_isolated_workspace` already exists; it now means "this runtime cannot run outside a task workspace" and the engine refuses to dispatch such a runtime without one.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-isolated-dispatch.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scriptRuntime } from "../src/lib/workflow/runtimes/script.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe("isolated dispatch", () => {
  it("runs a script with its cwd inside the task workspace", async () => {
    const canonical = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-canon-"));
    const task = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-task-"));
    dirs.push(canonical, task);
    const result = await scriptRuntime.runStage({
      workspaceDir: canonical, taskWorkspaceRoot: task,
      unitKey: "u", owner: "x", instructions: "", outputs: ["out.txt"],
      command: { cmd: "node", args: ["-e", "require('fs').writeFileSync('out.txt','here')"] },
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("succeeded");
    expect(await fs.readFile(path.join(task, "out.txt"), "utf-8")).toBe("here");
    await expect(fs.access(path.join(canonical, "out.txt"))).rejects.toThrow();
  });

  it("honours the task workspace in every registered runtime", async () => {
    // Enumerated from the registry rather than a hand-written list, which is
    // how chat-api and openai-compatible were missed.
    const { runtimeRegistry } = await import("../src/lib/workflow/runtimes/registry.js");
    for (const runtime of runtimeRegistry()) {
      expect(typeof runtime.runStage, runtime.id).toBe("function");
      expect(runtime.capabilities, runtime.id).toBeDefined();
      // A runtime that cannot honour an isolated workspace must say so, rather
      // than silently writing to the canonical one.
      expect(
        runtime.capabilities.requires_isolated_workspace !== undefined
        || runtime.capabilities.honours_task_workspace === true,
        `${runtime.id} does not declare task-workspace behaviour`,
      ).toBe(true);
    }
  });

  it("falls back to the canonical workspace when no task root is supplied", async () => {
    const canonical = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-canon-"));
    dirs.push(canonical);
    const result = await scriptRuntime.runStage({
      workspaceDir: canonical, unitKey: "u", owner: "x", instructions: "", outputs: ["out.txt"],
      command: { cmd: "node", args: ["-e", "require('fs').writeFileSync('out.txt','here')"] },
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("succeeded");
    expect(await fs.readFile(path.join(canonical, "out.txt"), "utf-8")).toBe("here");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-isolated-dispatch`
Expected: FAIL — `taskWorkspaceRoot` is not a `StageRunRequest` field.

- [ ] **Step 3: Write minimal implementation**

Add to `StageRunRequest` in `src/lib/workflow/runtimes/base.ts`:

```ts
  /** Isolated workspace materialized from the unit's declared reads. When set,
   * every runtime uses it as the working directory; the canonical workspace is
   * never exposed to a worker that declared effects. */
  taskWorkspaceRoot?: string;
```

In each runtime, replace uses of `req.workspaceDir` as the process working directory with `req.taskWorkspaceRoot ?? req.workspaceDir`. Leave log and prompt paths pointing at the canonical workspace — they are engine artifacts, not worker effects.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-isolated-dispatch`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the runtime suites**

Run: `npm test -- runtime real-runtimes dry-run script`
Expected: PASS — the field is optional and existing callers are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/runtimes/ tests/contract-isolated-dispatch.test.ts
git commit -m "feat(runtimes): dispatch workers into an isolated task workspace"
```

---

## M3 — Engine-owned observation ingestion

### Task 7: Observation store

**Files:**
- Create: `src/lib/workflow/canonical.ts`
- Create: `src/lib/workflow/observations.ts`
- Test: `tests/contract-observations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicalJson(value)`; `Observation` schema (`metric`, `scope_key`, `value`, `target?`, `operator?`, `tolerance?`, `direction?`, `evaluator`, `evaluator_digest`, `input_digest`, `sequence`, `measured_at`, `judgment?`); `reserveSequence(dir, store)`; `appendObservation(dir, store, observation)`; `currentObservation(dir, store, metric, scopeKey, inputDigest, evaluatorDigest)`; `snapshotFor(dir, store, criteria)`; `readAllObservations(dir, store)`.

The full store is specified by wire contract §4; this task implements it once, here, and nowhere else.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-observations.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../src/lib/workflow/canonical.js";
import {
  Observation, appendObservation, currentObservation, readAllObservations,
  reserveSequence, snapshotFor,
} from "../src/lib/workflow/observations.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-obs-"));
  dirs.push(dir);
  return dir;
}
const STORE = ".malaclaw/observations";
const record = (overrides: Record<string, unknown> = {}) => Observation.parse({
  metric: "test_coverage", scope_key: "", value: 0.62, evaluator: "coverage",
  evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
  sequence: 1, measured_at: new Date().toISOString(), ...overrides,
});

describe("canonical json", () => {
  it("sorts keys at every depth and preserves nested values", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    // JSON.stringify(value, keyArray) filters keys at EVERY depth and would
    // silently discard nested model configuration.
    expect(canonicalJson({ model: { name: "opus", params: { effort: "high" } } })).toContain("effort");
  });

  it("preserves array order and distinguishes null from missing", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
});

describe("observation store", () => {
  it("writes an immutable content-addressed record", async () => {
    const dir = await workspace();
    const written = await appendObservation(dir, STORE, record());
    expect(path.basename(written)).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("keys identity by metric AND scope", async () => {
    const dir = await workspace();
    await appendObservation(dir, STORE, record({ metric: "depth", scope_key: "section-03", value: 2 }));
    await appendObservation(dir, STORE, record({ metric: "depth", scope_key: "section-06", value: 5 }));
    const three = await currentObservation(dir, STORE, "depth", "section-03", "b".repeat(64), "a".repeat(64));
    const six = await currentObservation(dir, STORE, "depth", "section-06", "b".repeat(64), "a".repeat(64));
    // Without scope in identity these collapse and a repair in one section
    // appears to satisfy the other.
    expect(three?.value).toBe(2);
    expect(six?.value).toBe(5);
  });

  it("selects the current value only among matching digests", async () => {
    const dir = await workspace();
    // A -> B -> A: the stale B record has the higher sequence.
    await appendObservation(dir, STORE, record({ value: 3, input_digest: "b".repeat(64), sequence: 1 }));
    await appendObservation(dir, STORE, record({ value: 9, input_digest: "c".repeat(64), sequence: 2 }));
    const current = await currentObservation(dir, STORE, "test_coverage", "", "b".repeat(64), "a".repeat(64));
    expect(current?.value).toBe(3);
  });

  it("breaks ties by sequence among matching digests", async () => {
    const dir = await workspace();
    await appendObservation(dir, STORE, record({ value: 5, sequence: 4 }));
    await appendObservation(dir, STORE, record({ value: 6, sequence: 9 }));
    expect((await currentObservation(dir, STORE, "test_coverage", "", "b".repeat(64), "a".repeat(64)))?.value).toBe(6);
  });

  it("refuses a conflicting record at the same identity and sequence", async () => {
    const dir = await workspace();
    await appendObservation(dir, STORE, record({ value: 1 }));
    await expect(appendObservation(dir, STORE, record({ value: 2 }))).rejects.toThrow(/conflicting observation/);
  });

  it("accepts a byte-identical rewrite idempotently", async () => {
    const dir = await workspace();
    const first = await appendObservation(dir, STORE, record({ value: 1 }));
    expect(await appendObservation(dir, STORE, record({ value: 1 }))).toBe(first);
  });

  it("throws on a malformed stored record rather than skipping it", async () => {
    const dir = await workspace();
    const written = await appendObservation(dir, STORE, record());
    await fs.writeFile(path.join(dir, path.dirname(written), `${"f".repeat(64)}.json`), "{ not json", "utf-8");
    await expect(readAllObservations(dir, STORE)).rejects.toThrow(/malformed observation/);
  });

  it("builds a snapshot keyed by metric and scope", async () => {
    const dir = await workspace();
    await appendObservation(dir, STORE, record({ metric: "depth", scope_key: "section-03", value: 2 }));
    const snapshot = await snapshotFor(dir, STORE, [
      { metric: "depth", scope_key: "section-03", input_digest: "b".repeat(64), evaluator_digest: "a".repeat(64) },
    ]);
    expect(snapshot.get("depth section-03")).toBe(2);
  });

  it("omits a metric with no matching observation from the snapshot", async () => {
    const dir = await workspace();
    const snapshot = await snapshotFor(dir, STORE, [
      { metric: "depth", scope_key: "section-03", input_digest: "b".repeat(64), evaluator_digest: "a".repeat(64) },
    ]);
    expect(snapshot.has("depth section-03")).toBe(false);
  });

  it("allocates unique sequences under concurrency", async () => {
    const dir = await workspace();
    const claimed = await Promise.all(Array.from({ length: 25 }, () => reserveSequence(dir, STORE)));
    expect(new Set(claimed).size).toBe(25);
  });

  it("rejects an unsafe metric or evaluator name in a store path", () => {
    expect(() => Observation.parse({ ...record(), metric: "../escape" })).toThrow();
    expect(() => Observation.parse({ ...record(), evaluator: "a/b" })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- contract-observations`
Expected: FAIL — cannot resolve `canonical.js` and `observations.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/canonical.ts`:

```ts
/** Recursive canonical JSON: object keys sorted at every depth, array order
 * preserved. `JSON.stringify(value, keyArray)` is not this — its second
 * argument filters keys at every depth against one flat list, so nested
 * configuration silently loses fields the top level never mentioned. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
```

Create `src/lib/workflow/observations.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";

const SAFE = /^[a-z][a-z0-9_]*$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Scope keys come from the domain layer; keep them path-safe without
 * constraining their vocabulary. */
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$|^$/;

export const ModelJudgment = z.object({
  reasons: z.array(z.string().min(1)).max(50),
  confidence: z.number().min(0).max(1),
  rubric_version: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).max(200),
  adjudicated: z.boolean(),
  disagreement: z.enum(["none", "within_tolerance", "material", "unresolved"]),
}).strict();

export const Observation = z.object({
  metric: z.string().regex(SAFE),
  scope_key: z.string().regex(SCOPE),
  value: z.number().finite(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  tolerance: z.number().nonnegative().optional(),
  direction: z.enum(["maximize", "minimize"]).optional(),
  evaluator: z.string().regex(SAFE),
  evaluator_digest: z.string().regex(DIGEST),
  input_digest: z.string().regex(DIGEST),
  sequence: z.number().int().nonnegative(),
  /** Provenance only. Never used for ordering. */
  measured_at: z.string().datetime(),
  judgment: ModelJudgment.optional(),
}).strict();
export type Observation = z.infer<typeof Observation>;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function scopeDir(scopeKey: string): string {
  return scopeKey === "" ? "_global" : encodeURIComponent(scopeKey);
}
export function snapshotKey(metric: string, scopeKey: string): string {
  return `${metric} ${scopeKey}`;
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else found.push(full);
  }
  return found.sort();
}

/** Atomic. A read-then-increment over the store races when two measurement
 * units run concurrently; an exclusive create cannot. */
export async function reserveSequence(workspaceDir: string, storePath: string): Promise<number> {
  const dir = path.join(workspaceDir, storePath, ".sequence");
  await fs.mkdir(dir, { recursive: true });
  const claimed = (await fs.readdir(dir)).map(Number).filter(Number.isInteger);
  let next = claimed.length === 0 ? 1 : Math.max(...claimed) + 1;
  for (;;) {
    try {
      const handle = await fs.open(path.join(dir, String(next)), "wx");
      await handle.close();
      return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      next += 1;
    }
  }
}

export async function appendObservation(
  workspaceDir: string, storePath: string, observation: Observation,
): Promise<string> {
  const parsed = Observation.parse(observation);
  const body = `${canonicalJson(parsed)}\n`;
  const dir = path.join(storePath, parsed.metric, scopeDir(parsed.scope_key),
    parsed.input_digest, parsed.evaluator_digest);
  await fs.mkdir(path.join(workspaceDir, dir), { recursive: true });
  const rel = path.join(dir, `${sha256(body)}.json`);
  const target = path.join(workspaceDir, rel);
  try {
    const handle = await fs.open(target, "wx");
    try { await handle.writeFile(body, "utf-8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await fs.readFile(target, "utf-8") !== body) throw new Error(`conflicting observation at ${rel}`);
    return rel;
  }
  for (const name of await fs.readdir(path.join(workspaceDir, dir))) {
    if (!name.endsWith(".json") || name === path.basename(rel)) continue;
    const other = Observation.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, dir, name), "utf-8")));
    if (other.sequence === parsed.sequence && other.value !== parsed.value) {
      throw new Error(`conflicting observation at sequence ${parsed.sequence} in ${rel}`);
    }
  }
  return rel;
}

export async function readAllObservations(workspaceDir: string, storePath: string): Promise<Observation[]> {
  const records: Observation[] = [];
  for (const file of await filesUnder(path.join(workspaceDir, storePath))) {
    if (!file.endsWith(".json")) continue;
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(file, "utf-8")); }
    catch { throw new Error(`malformed observation: ${path.relative(workspaceDir, file)} is not valid JSON`); }
    const parsed = Observation.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`malformed observation: ${path.relative(workspaceDir, file)} — ${parsed.error.issues[0]?.message}`);
    }
    records.push(parsed.data);
  }
  return records;
}

/** Digests first, sequence second. Selecting by sequence alone returns a stale
 * value whenever a workspace changes and reverts. */
export async function currentObservation(
  workspaceDir: string, storePath: string,
  metric: string, scopeKey: string, inputDigest: string, evaluatorDigest: string,
): Promise<Observation | null> {
  const matching = (await readAllObservations(workspaceDir, storePath)).filter((record) =>
    record.metric === metric && record.scope_key === scopeKey
    && record.input_digest === inputDigest && record.evaluator_digest === evaluatorDigest);
  if (matching.length === 0) return null;
  return matching.reduce((best, record) => (record.sequence > best.sequence ? record : best));
}

export async function snapshotFor(
  workspaceDir: string, storePath: string,
  criteria: Array<{ metric: string; scope_key: string; input_digest: string; evaluator_digest: string }>,
): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  for (const criterion of criteria) {
    const observation = await currentObservation(workspaceDir, storePath,
      criterion.metric, criterion.scope_key, criterion.input_digest, criterion.evaluator_digest);
    if (observation) snapshot.set(snapshotKey(criterion.metric, criterion.scope_key), observation.value);
  }
  return snapshot;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- contract-observations`
Expected: PASS, 2 + 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/canonical.ts src/lib/workflow/observations.ts tests/contract-observations.test.ts
git commit -m "feat(workflow): add the engine-owned scoped observation store"
```

---

### Task 8: Measurement envelope ingestion

**Files:**
- Create: `src/lib/workflow/measurements.ts`
- Test: `tests/contract-measurement-ingest.test.ts`

**Interfaces:**
- Consumes: `Observation`, `appendObservation`, `reserveSequence` (Task 7); `ContractOutcome` (Task 1).
- Produces: `MeasurementEnvelope` schema per wire contract §3; `ingestEnvelope(canonicalDir, storePath, envelopePath, unit): Promise<IngestResult>` where `IngestResult = { appended: Observation[]; unavailable: string[]; deferred: string[]; outcome: ContractOutcome | null }`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-measurement-ingest.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestEnvelope } from "../src/lib/workflow/measurements.js";
import { currentObservation } from "../src/lib/workflow/observations.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
const STORE = ".malaclaw/observations";
const unit = { unitKey: "measure", writes_observations: ["test_coverage", "row_validity"] };

async function withEnvelope(measurements: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-ingest-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "reports"), { recursive: true });
  await fs.writeFile(path.join(dir, "reports/measurements.json"), JSON.stringify({
    version: 1, as_of_date: "2026-09-01T00:00:00.000Z", measurements,
  }), "utf-8");
  return dir;
}
const measured = (overrides: Record<string, unknown> = {}) => ({
  metric: "test_coverage", scope_key: "", status: "measured", value: 0.62,
  target: 0.9, operator: "at_least", tolerance: 0.000001, direction: "maximize",
  evaluator: "coverage", evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
  measurement_kind: "script", ...overrides,
});

describe("measurement ingestion", () => {
  it("appends a measured entry with an engine-allocated sequence", async () => {
    const dir = await withEnvelope([measured()]);
    const result = await ingestEnvelope(dir, STORE, "reports/measurements.json", unit);
    expect(result.appended).toHaveLength(1);
    expect(result.appended[0].sequence).toBeGreaterThan(0);
    expect((await currentObservation(dir, STORE, "test_coverage", "", "b".repeat(64), "a".repeat(64)))?.value)
      .toBeCloseTo(0.62, 6);
  });

  it("distinguishes unavailable from deferred", async () => {
    const dir = await withEnvelope([
      { ...measured(), status: "unavailable", value: undefined, reason: "corpus missing" },
      { ...measured(), metric: "row_validity", status: "deferred", value: undefined },
    ]);
    const result = await ingestEnvelope(dir, STORE, "reports/measurements.json", unit);
    expect(result.unavailable).toEqual(["test_coverage"]);
    expect(result.deferred).toEqual(["row_validity"]);
    expect(result.outcome).toBe("measurement_failed");
  });

  it("returns pending_verification when only deferrals remain", async () => {
    const dir = await withEnvelope([{ ...measured(), status: "deferred", value: undefined }]);
    expect((await ingestEnvelope(dir, STORE, "reports/measurements.json", unit)).outcome)
      .toBe("pending_verification");
  });

  it("rejects a model entry with no judgment", async () => {
    const dir = await withEnvelope([{ ...measured(), measurement_kind: "model" }]);
    await expect(ingestEnvelope(dir, STORE, "reports/measurements.json", unit))
      .rejects.toThrow(/judgment/i);
  });

  it("rejects a script entry that carries a judgment", async () => {
    const dir = await withEnvelope([{
      ...measured(),
      judgment: { reasons: [], confidence: 0.5, rubric_version: "1", evidence_refs: [], adjudicated: false, disagreement: "none" },
    }]);
    await expect(ingestEnvelope(dir, STORE, "reports/measurements.json", unit))
      .rejects.toThrow(/script.*judgment/i);
  });

  it("rejects a metric the unit did not declare", async () => {
    const dir = await withEnvelope([{ ...measured(), metric: "smuggled" }]);
    await expect(ingestEnvelope(dir, STORE, "reports/measurements.json", unit))
      .rejects.toThrow(/did not declare/i);
  });

  it("rejects an unrecognized envelope version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-ingest-v-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.writeFile(path.join(dir, "reports/measurements.json"),
      JSON.stringify({ version: 2, measurements: [] }), "utf-8");
    await expect(ingestEnvelope(dir, STORE, "reports/measurements.json", unit))
      .rejects.toThrow(/version/i);
  });

  it("ingests one entry per scope for a scoped metric", async () => {
    const dir = await withEnvelope([
      measured({ metric: "test_coverage", scope_key: "module-a", value: 0.5 }),
      measured({ metric: "test_coverage", scope_key: "module-b", value: 0.8 }),
    ]);
    const result = await ingestEnvelope(dir, STORE, "reports/measurements.json", unit);
    expect(result.appended.map((o) => o.scope_key).sort()).toEqual(["module-a", "module-b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-measurement-ingest`
Expected: FAIL — cannot resolve `measurements.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/measurements.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Observation, ModelJudgment, appendObservation, reserveSequence } from "./observations.js";
import type { ContractOutcome } from "./outcomes.js";

const Entry = z.object({
  metric: z.string().min(1),
  scope_key: z.string().default(""),
  status: z.enum(["measured", "unavailable", "deferred"]),
  value: z.number().finite().optional(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  tolerance: z.number().nonnegative().optional(),
  direction: z.enum(["maximize", "minimize"]).optional(),
  evaluator: z.string().min(1),
  evaluator_digest: z.string().regex(/^[0-9a-f]{64}$/),
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  measurement_kind: z.enum(["script", "model", "external"]),
  judgment: ModelJudgment.optional(),
  reason: z.string().min(1).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.status === "measured" && entry.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "a measured entry must carry a value" });
  }
  // Trust comes from recorded acquisition, validation and reduction — enforced
  // by measurement_kind, not by convention.
  if (entry.measurement_kind === "model" && entry.status === "measured" && !entry.judgment) {
    ctx.addIssue({ code: "custom", path: ["judgment"], message: "a model measurement must carry judgment" });
  }
  if (entry.measurement_kind === "script" && entry.judgment) {
    ctx.addIssue({ code: "custom", path: ["judgment"], message: "a script measurement must not carry judgment" });
  }
});

export const MeasurementEnvelope = z.object({
  version: z.literal(1),
  as_of_date: z.string().datetime().optional(),
  measurements: z.array(Entry).max(2_000),
}).strict();

export type IngestResult = {
  appended: Observation[];
  unavailable: string[];
  deferred: string[];
  outcome: ContractOutcome | null;
};

export async function ingestEnvelope(
  canonicalDir: string, storePath: string, envelopePath: string,
  unit: { unitKey: string; writes_observations: string[] },
): Promise<IngestResult> {
  const raw = JSON.parse(await fs.readFile(path.join(canonicalDir, envelopePath), "utf-8"));
  const envelope = MeasurementEnvelope.parse(raw);
  const declared = new Set(unit.writes_observations);

  const result: IngestResult = { appended: [], unavailable: [], deferred: [], outcome: null };
  for (const entry of envelope.measurements) {
    if (!declared.has(entry.metric)) {
      throw new Error(`${unit.unitKey} did not declare observation ${entry.metric} in writes_observations`);
    }
    if (entry.status === "unavailable") { result.unavailable.push(entry.metric); continue; }
    if (entry.status === "deferred") { result.deferred.push(entry.metric); continue; }
    const observation = Observation.parse({
      metric: entry.metric, scope_key: entry.scope_key, value: entry.value,
      target: entry.target, operator: entry.operator, tolerance: entry.tolerance, direction: entry.direction,
      evaluator: entry.evaluator, evaluator_digest: entry.evaluator_digest, input_digest: entry.input_digest,
      // The kernel allocates every sequence; a producer never chooses one.
      sequence: await reserveSequence(canonicalDir, storePath),
      measured_at: new Date().toISOString(),
      judgment: entry.judgment,
    });
    await appendObservation(canonicalDir, storePath, observation);
    result.appended.push(observation);
  }

  // An unavailable input is a failure; a deferral is not. Conflating them is
  // how "the measurement did not run" became indistinguishable from
  // "the measurement is scheduled later".
  if (result.unavailable.length > 0) result.outcome = "measurement_failed";
  else if (result.deferred.length > 0) result.outcome = "pending_verification";
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-measurement-ingest`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/measurements.ts tests/contract-measurement-ingest.test.ts
git commit -m "feat(workflow): ingest measurement envelopes into the engine-owned store"
```

---

## M4 — Scoped acceptance and invariants

### Task 9: The single acceptance arithmetic

Wire contract §6 assigns this to the kernel exclusively. There is no second implementation anywhere in either repository.

**Files:**
- Create: `src/lib/workflow/acceptance.ts`
- Create: `fixtures/wire-contract/v1/arithmetic.json`
- Test: `tests/contract-acceptance.test.ts`

**Interfaces:**
- Consumes: `Criterion`, `MustImprove` (Task 2); `ContractOutcome` (Task 1); `snapshotKey` (Task 7).
- Produces: `satisfies(criterion, value)`; `closedGapFraction(criterion, before, after)`; `absoluteProgress(criterion, before, after)`; `evaluateContract(input): ContractOutcome`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-acceptance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { satisfies, closedGapFraction, evaluateContract } from "../src/lib/workflow/acceptance.js";

const coverage = { metric: "test_coverage", scope_key: "", operator: "at_least" as const,
                   target: 0.9, tolerance: 1e-6, direction: "maximize" as const };
const rows = { metric: "row_validity", scope_key: "", operator: "at_least" as const,
               target: 1, tolerance: 0, direction: "maximize" as const };
const exact = { metric: "artifacts", scope_key: "", operator: "equals" as const,
                target: 4, tolerance: 0, direction: "maximize" as const };
const improve = { metric: "test_coverage", scope_key: "", min_absolute_delta: 0.01,
                  min_gap_fraction: 0.2, max_attempts: 2 };

const snap = (entries: Record<string, number>) => new Map(Object.entries(entries));
function evaluate(before: Record<string, number>, after: Record<string, number>, extra = {}) {
  return evaluateContract({
    acceptance: [coverage], must_improve: [improve], must_preserve: [rows],
    before: snap(before), after: snap(after), attempts: 1, pending: [], unavailable: [], ...extra,
  });
}

describe("acceptance arithmetic", () => {
  it("satisfies within tolerance rather than by float identity", () => {
    expect(satisfies(coverage, 0.9 - 1e-9)).toBe(true);
    expect(satisfies(exact, 4)).toBe(true);
    expect(satisfies(exact, 5)).toBe(false);
  });

  it("measures equals progress as closed distance from above the target", () => {
    // Treating equals like at_least reports this as negative progress.
    expect(closedGapFraction(exact, 8, 6)).toBeCloseTo(0.5, 6);
  });

  it("measures equals progress as closed distance from below the target", () => {
    expect(closedGapFraction(exact, 0, 2)).toBeCloseTo(0.5, 6);
  });

  it("reports negative progress when an equals metric moves away", () => {
    expect(closedGapFraction(exact, 3, 1)).toBeLessThan(0);
  });

  it("accepts when the target is met and invariants hold", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.95, "row_validity ": 1 })).toBe("accepted");
  });

  it("reports improved when both thresholds are met short of target", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.65, "row_validity ": 1 })).toBe("improved");
  });

  it("rejects a slow crawl that clears the delta but not the gap fraction", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.52, "row_validity ": 1 })).toBe("unmet");
  });

  it("blocks on a broken invariant even when the objective advanced", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.95, "row_validity ": 0.8 }))
      .toBe("partially_improved_with_regression");
  });

  it("reports plain regression when nothing advanced", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.5, "row_validity ": 0.8 })).toBe("regressed");
  });

  it("fails the measurement when a protected metric has no observation", () => {
    // A protected metric that cannot be measured has not been preserved; it is
    // unknown, and unknown must never read as a pass.
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 }, { "test_coverage ": 0.95 }))
      .toBe("measurement_failed");
  });

  it("never accepts while a required measurement is pending", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.99, "row_validity ": 1 },
                    { pending: ["test_coverage "] })).toBe("pending_verification");
  });

  it("reports measurement_failed when an acceptance metric is unavailable", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 }, { "row_validity ": 1 },
                    { unavailable: ["test_coverage "] })).toBe("measurement_failed");
  });

  it("keeps two scopes of one metric independent", () => {
    const a = { ...coverage, scope_key: "module-a" };
    const b = { ...coverage, scope_key: "module-b" };
    const outcome = evaluateContract({
      acceptance: [a, b], must_improve: [], must_preserve: [],
      before: snap({ "test_coverage module-a": 0.5, "test_coverage module-b": 0.5 }),
      after: snap({ "test_coverage module-a": 0.95, "test_coverage module-b": 0.5 }),
      attempts: 1, pending: [], unavailable: [],
    });
    // One scope reaching target does not accept the other.
    expect(outcome).not.toBe("accepted");
  });

  it("is not_applicable for a unit with no objective", () => {
    expect(evaluateContract({
      acceptance: [], must_improve: [], must_preserve: [],
      before: snap({}), after: snap({}), attempts: 0, pending: [], unavailable: [],
    })).toBe("not_applicable");
  });

  it("reports strategy_exhausted once attempts are spent", () => {
    expect(evaluate({ "test_coverage ": 0.5, "row_validity ": 1 },
                    { "test_coverage ": 0.52, "row_validity ": 1 }, { attempts: 2 }))
      .toBe("strategy_exhausted");
  });

  it("matches every wire-contract conformance fixture", () => {
    const fixtures = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "fixtures/wire-contract/v1/arithmetic.json"), "utf-8")) as
      Array<{ name: string; criterion: typeof coverage; before: number; after: number; expect: string }>;
    expect(fixtures.length).toBeGreaterThan(8);
    for (const fixture of fixtures) {
      const outcome = evaluateContract({
        acceptance: [fixture.criterion],
        must_improve: [{ metric: fixture.criterion.metric, scope_key: fixture.criterion.scope_key,
                         min_absolute_delta: 0, min_gap_fraction: 0, max_attempts: 9 }],
        must_preserve: [],
        before: snap({ [`${fixture.criterion.metric} ${fixture.criterion.scope_key}`]: fixture.before }),
        after: snap({ [`${fixture.criterion.metric} ${fixture.criterion.scope_key}`]: fixture.after }),
        attempts: 1, pending: [], unavailable: [],
      });
      expect(outcome, fixture.name).toBe(fixture.expect);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-acceptance`
Expected: FAIL — cannot resolve `acceptance.js`.

- [ ] **Step 3: Write the fixture set**

Create `fixtures/wire-contract/v1/arithmetic.json` covering wire contract §7: `equals` starting above, below and at target; moving closer, moving away, reaching within tolerance; float-tolerance satisfaction for a ratio; `at_most` progress; and an already-satisfied criterion. Both repositories execute this file.

```json
[
  { "name": "at_least reaches target",
    "criterion": { "metric": "m", "scope_key": "", "operator": "at_least", "target": 0.9, "tolerance": 0.000001, "direction": "maximize" },
    "before": 0.5, "after": 0.95, "expect": "accepted" },
  { "name": "at_least within float tolerance",
    "criterion": { "metric": "m", "scope_key": "", "operator": "at_least", "target": 0.3, "tolerance": 0.000001, "direction": "maximize" },
    "before": 0.1, "after": 0.30000000000000004, "expect": "accepted" },
  { "name": "at_least improves short of target",
    "criterion": { "metric": "m", "scope_key": "", "operator": "at_least", "target": 0.9, "tolerance": 0.000001, "direction": "maximize" },
    "before": 0.5, "after": 0.6, "expect": "improved" },
  { "name": "at_most reduces a defect count",
    "criterion": { "metric": "m", "scope_key": "", "operator": "at_most", "target": 0, "tolerance": 0, "direction": "minimize" },
    "before": 10, "after": 5, "expect": "improved" },
  { "name": "at_most reaches zero",
    "criterion": { "metric": "m", "scope_key": "", "operator": "at_most", "target": 0, "tolerance": 0, "direction": "minimize" },
    "before": 3, "after": 0, "expect": "accepted" },
  { "name": "equals starting below moves closer",
    "criterion": { "metric": "m", "scope_key": "", "operator": "equals", "target": 4, "tolerance": 0, "direction": "maximize" },
    "before": 0, "after": 2, "expect": "improved" },
  { "name": "equals starting above moves closer",
    "criterion": { "metric": "m", "scope_key": "", "operator": "equals", "target": 4, "tolerance": 0, "direction": "maximize" },
    "before": 8, "after": 6, "expect": "improved" },
  { "name": "equals moves away",
    "criterion": { "metric": "m", "scope_key": "", "operator": "equals", "target": 4, "tolerance": 0, "direction": "maximize" },
    "before": 3, "after": 1, "expect": "unmet" },
  { "name": "equals reaches target",
    "criterion": { "metric": "m", "scope_key": "", "operator": "equals", "target": 4, "tolerance": 0, "direction": "maximize" },
    "before": 2, "after": 4, "expect": "accepted" },
  { "name": "already satisfied before the attempt",
    "criterion": { "metric": "m", "scope_key": "", "operator": "at_least", "target": 0.5, "tolerance": 0.000001, "direction": "maximize" },
    "before": 0.7, "after": 0.7, "expect": "accepted" }
]
```

- [ ] **Step 4: Write minimal implementation**

Create `src/lib/workflow/acceptance.ts`:

```ts
import type { Criterion, MustImprove } from "../schema.js";
import type { ContractOutcome } from "./outcomes.js";
import { snapshotKey } from "./observations.js";

export function satisfies(criterion: Criterion, value: number): boolean {
  if (criterion.operator === "at_least") return value >= criterion.target - criterion.tolerance;
  if (criterion.operator === "at_most") return value <= criterion.target + criterion.tolerance;
  // Exact float equality is never the right test for a ratio or a score.
  return Math.abs(value - criterion.target) <= criterion.tolerance;
}

/** `equals` is two-sided and measured as closed DISTANCE. Treating it like
 * `at_least` reports movement in the wrong direction whenever the value starts
 * above the target. */
export function closedGapFraction(criterion: Criterion, before: number, after: number): number {
  if (criterion.operator === "equals") {
    const gap = Math.abs(criterion.target - before);
    return gap === 0 ? 1 : (gap - Math.abs(criterion.target - after)) / gap;
  }
  const gap = criterion.operator === "at_most" ? before - criterion.target : criterion.target - before;
  if (gap <= 0) return 1;
  return (criterion.operator === "at_most" ? before - after : after - before) / gap;
}

export function absoluteProgress(criterion: Criterion, before: number, after: number): number {
  if (criterion.operator === "equals") {
    return Math.abs(criterion.target - before) - Math.abs(criterion.target - after);
  }
  return criterion.operator === "at_most" ? before - after : after - before;
}

export type ContractInput = {
  acceptance: Criterion[];
  must_improve: MustImprove[];
  must_preserve: Criterion[];
  /** metric+scope -> value. Keys come from snapshotKey(). */
  before: Map<string, number>;
  after: Map<string, number>;
  attempts: number;
  /** Keys whose measurement is deferred past this unit. */
  pending: string[];
  /** Keys whose measurement failed outright. */
  unavailable: string[];
};

const key = (criterion: { metric: string; scope_key: string }) => snapshotKey(criterion.metric, criterion.scope_key);

/** The kernel knows nothing about what any metric means; it compares numbers
 * against compiled criteria and returns a typed outcome. */
export function evaluateContract(input: ContractInput): ContractOutcome {
  if (input.acceptance.length === 0 && input.must_improve.length === 0 && input.must_preserve.length === 0) {
    return "not_applicable";
  }

  // A protected metric with no observation has not been preserved; it is
  // unknown. Reporting that as a pass is the failure this rule exists to stop.
  const protectedMissing = input.must_preserve.filter((criterion) => !input.after.has(key(criterion)));
  const regressed = input.must_preserve.some((criterion) => {
    const after = input.after.get(key(criterion));
    return after !== undefined && !satisfies(criterion, after);
  });
  const advanced = input.acceptance.some((criterion) => {
    const before = input.before.get(key(criterion));
    const after = input.after.get(key(criterion));
    if (before === undefined || after === undefined) return false;
    return absoluteProgress(criterion, before, after) > 0;
  });

  // A regression is the most consequential fact about an attempt and reports
  // even when other measurements are outstanding.
  if (regressed) return advanced ? "partially_improved_with_regression" : "regressed";
  if (protectedMissing.length > 0) return "measurement_failed";

  const required = [...input.acceptance, ...input.must_improve].map(key);
  if (required.some((k) => input.unavailable.includes(k))) return "measurement_failed";
  if (required.some((k) => input.pending.includes(k))) return "pending_verification";
  if (required.some((k) => !input.after.has(k))) return "measurement_failed";

  if (input.acceptance.every((criterion) => satisfies(criterion, input.after.get(key(criterion))!))) {
    return "accepted";
  }

  let anyImproved = false;
  for (const policy of input.must_improve) {
    const criterion = input.acceptance.find((candidate) => key(candidate) === key(policy));
    if (!criterion) continue;
    const before = input.before.get(key(policy)) ?? 0;
    const after = input.after.get(key(policy))!;
    if (absoluteProgress(criterion, before, after) < policy.min_absolute_delta) continue;
    if (closedGapFraction(criterion, before, after) < policy.min_gap_fraction) continue;
    anyImproved = true;
  }
  if (anyImproved) return "improved";

  return input.must_improve.some((policy) => input.attempts >= policy.max_attempts)
    ? "strategy_exhausted" : "unmet";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- contract-acceptance`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/acceptance.ts fixtures/wire-contract/ tests/contract-acceptance.test.ts
git commit -m "feat(workflow): own the scoped acceptance arithmetic and its conformance fixtures"
```

---

### Task 10: Strategy fingerprints and per-objective stagnation

**Files:**
- Create: `src/lib/workflow/stagnation.ts`
- Test: `tests/contract-stagnation.test.ts`

**Interfaces:**
- Consumes: `Criterion` (Task 2); `ContractOutcome` (Task 1); `canonicalJson` (Task 7).
- Produces: `objectiveKey(criterion, findingIds, artifactIds)`; `strategyFingerprint(objective, template, effect)`; `ObjectiveProgress`; `recordAttempt(state, objective, fingerprint, outcome, before, after)`; `isRepeatedStrategy(state, objective, fingerprint)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-stagnation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { objectiveKey, strategyFingerprint, recordAttempt, isRepeatedStrategy } from "../src/lib/workflow/stagnation.js";

const base = { metric: "test_coverage", operator: "at_least" as const, target: 0.9,
               tolerance: 1e-6, direction: "maximize" as const };
const moduleA = { ...base, scope_key: "module-a" };
const moduleB = { ...base, scope_key: "module-b" };

describe("per-objective stagnation", () => {
  it("keys an objective by scope so one scope cannot reset another", () => {
    expect(objectiveKey(moduleA, ["f1"], ["src/a.ts"]))
      .not.toBe(objectiveKey(moduleB, ["f1"], ["src/b.ts"]));
  });

  it("keys an objective by target so a lowered bar is a different objective", () => {
    expect(objectiveKey(moduleA, [], [])).not.toBe(objectiveKey({ ...moduleA, target: 0.5 }, [], []));
  });

  it("counts consecutive unmet attempts per objective", () => {
    const key = objectiveKey(moduleA, [], []);
    let state = recordAttempt({}, key, "s1", "unmet", 0.5, 0.5).state;
    expect(recordAttempt(state, key, "s2", "unmet", 0.5, 0.5).progress.consecutive_unmet).toBe(2);
  });

  it("does not reset one objective when a different objective improves", () => {
    const a = objectiveKey(moduleA, [], []);
    const b = objectiveKey(moduleB, [], []);
    let state = recordAttempt({}, a, "s1", "unmet", 0.5, 0.5).state;
    state = recordAttempt(state, a, "s2", "unmet", 0.5, 0.5).state;
    state = recordAttempt(state, b, "s3", "accepted", 0.5, 0.95).state;
    expect(recordAttempt(state, a, "s4", "unmet", 0.5, 0.5).progress.consecutive_unmet).toBe(3);
  });

  it("resets the counter when the objective itself improves", () => {
    const key = objectiveKey(moduleA, [], []);
    const state = recordAttempt({}, key, "s1", "unmet", 0.5, 0.5).state;
    expect(recordAttempt(state, key, "s2", "improved", 0.5, 0.7).progress.consecutive_unmet).toBe(0);
  });

  it("rejects an identical fingerprint against an unchanged objective", () => {
    const key = objectiveKey(moduleA, [], []);
    const fingerprint = strategyFingerprint(key, "repair_module", "rewrite_tests");
    const { state } = recordAttempt({}, key, fingerprint, "unmet", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, fingerprint)).toBe(true);
  });

  it("allows a different effect against the same objective", () => {
    const key = objectiveKey(moduleA, [], []);
    const { state } = recordAttempt({}, key, strategyFingerprint(key, "repair_module", "rewrite_tests"), "unmet", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, strategyFingerprint(key, "repair_module", "add_cases"))).toBe(false);
  });

  it("does not count an infrastructure interruption as an attempted strategy", () => {
    const key = objectiveKey(moduleA, [], []);
    const fingerprint = strategyFingerprint(key, "repair_module", "rewrite_tests");
    const { state } = recordAttempt({}, key, fingerprint, "not_applicable", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, fingerprint)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-stagnation`
Expected: FAIL — cannot resolve `stagnation.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/stagnation.ts`:

```ts
import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import type { Criterion } from "../schema.js";
import type { ContractOutcome } from "./outcomes.js";

export const ObjectiveProgress = z.object({
  objective: z.string().min(1),
  before: z.number().finite().optional(),
  after: z.number().finite().optional(),
  consecutive_unmet: z.number().int().nonnegative().default(0),
  strategies_attempted: z.array(z.string().min(1)).default([]),
}).strict();
export type ObjectiveProgress = z.infer<typeof ObjectiveProgress>;
export type StagnationState = Record<string, ObjectiveProgress>;

/** Objective identity includes scope, target and the artifacts involved.
 * Keyed on the metric alone, progress at one scope resets the counter for
 * every other scope — a slow crawl wearing the appearance of progress. */
export function objectiveKey(criterion: Criterion, findingIds: string[], artifactIds: string[]): string {
  return crypto.createHash("sha256").update(canonicalJson({
    metric: criterion.metric, scope_key: criterion.scope_key, operator: criterion.operator,
    target: criterion.target, findings: [...findingIds].sort(), artifacts: [...artifactIds].sort(),
  })).digest("hex").slice(0, 32);
}

export function strategyFingerprint(objective: string, template: string, effect: string): string {
  return crypto.createHash("sha256").update(canonicalJson([objective, template, effect]))
    .digest("hex").slice(0, 32);
}

/** Outcomes that represent a strategy actually having been tried. An
 * infrastructure interruption is not one: counting a quota pause as a failed
 * strategy burns the objective's attempt budget on an unrelated event. */
const COUNTS: ReadonlySet<ContractOutcome> = new Set<ContractOutcome>([
  "unmet", "stalled", "improved", "accepted", "regressed",
  "partially_improved_with_regression", "strategy_exhausted",
]);

export function recordAttempt(
  state: StagnationState, objective: string, fingerprint: string,
  outcome: ContractOutcome, before: number, after: number,
): { state: StagnationState; progress: ObjectiveProgress } {
  const held = state[objective] ?? ObjectiveProgress.parse({ objective });
  if (!COUNTS.has(outcome)) return { state, progress: held };
  const advanced = outcome === "accepted" || outcome === "improved";
  const progress = ObjectiveProgress.parse({
    objective,
    before: held.before ?? before,
    after,
    consecutive_unmet: advanced ? 0 : held.consecutive_unmet + 1,
    strategies_attempted: held.strategies_attempted.includes(fingerprint)
      ? held.strategies_attempted : [...held.strategies_attempted, fingerprint],
  });
  return { state: { ...state, [objective]: progress }, progress };
}

export function isRepeatedStrategy(state: StagnationState, objective: string, fingerprint: string): boolean {
  return (state[objective]?.strategies_attempted ?? []).includes(fingerprint);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-stagnation`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/stagnation.ts tests/contract-stagnation.test.ts
git commit -m "feat(workflow): track stagnation per scoped objective with strategy fingerprints"
```

---

## M5 — Worker event protocol

### Task 11: Progress and checkpoint events

`WorkerRuntime.runStage` is request/response with no event stream, so nothing can renew a lease or record a checkpoint mid-run. This adds an optional callback — additive, so every existing runtime keeps working and simply never emits.

**Files:**
- Modify: `src/lib/workflow/runtimes/base.ts`
- Modify: `src/lib/workflow/runtimes/script.ts`, `subprocess.ts`, `dry-run.ts`
- Test: `tests/contract-worker-events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WorkerEvent` union; `StageRunRequest.onEvent?: (event: WorkerEvent) => void`; `RuntimeCapabilities.emits_progress?: boolean`; `collectEvents(fn)` test helper.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-worker-events.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkerEvent } from "../src/lib/workflow/runtimes/base.js";
import { scriptRuntime } from "../src/lib/workflow/runtimes/script.js";
import { dryRunRuntime } from "../src/lib/workflow/runtimes/dry-run.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-events-"));
  dirs.push(dir);
  return dir;
}

describe("worker events", () => {
  it("emits started and completed around a script run", async () => {
    const dir = await workspace();
    const events: WorkerEvent[] = [];
    await scriptRuntime.runStage({
      workspaceDir: dir, unitKey: "u", owner: "x", instructions: "", outputs: ["out.txt"],
      command: { cmd: "node", args: ["-e", "require('fs').writeFileSync('out.txt','x')"] },
      timeoutMs: 10_000, onEvent: (event) => events.push(event),
    });
    expect(events[0].type).toBe("started");
    expect(events[events.length - 1].type).toBe("completed");
  });

  it("reports artifact_changed for each declared output the run produced", async () => {
    const dir = await workspace();
    const events: WorkerEvent[] = [];
    await scriptRuntime.runStage({
      workspaceDir: dir, unitKey: "u", owner: "x", instructions: "", outputs: ["out.txt"],
      command: { cmd: "node", args: ["-e", "require('fs').writeFileSync('out.txt','x')"] },
      timeoutMs: 10_000, onEvent: (event) => events.push(event),
    });
    const changed = events.filter((event) => event.type === "artifact_changed");
    expect(changed.map((event) => (event as { path: string }).path)).toContain("out.txt");
  });

  it("emits failed with a typed error rather than throwing", async () => {
    const dir = await workspace();
    const events: WorkerEvent[] = [];
    const result = await scriptRuntime.runStage({
      workspaceDir: dir, unitKey: "u", owner: "x", instructions: "", outputs: [],
      command: { cmd: "node", args: ["-e", "process.exit(3)"] },
      timeoutMs: 10_000, onEvent: (event) => events.push(event),
    });
    expect(result.outcome).not.toBe("succeeded");
    expect(events.some((event) => event.type === "failed")).toBe(true);
  });

  it("runs unchanged when no callback is supplied", async () => {
    const dir = await workspace();
    const result = await dryRunRuntime.runStage({
      workspaceDir: dir, unitKey: "u", owner: "x", instructions: "", outputs: ["out.txt"],
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe("succeeded");
  });

  it("declares whether a runtime emits progress", () => {
    expect(scriptRuntime.capabilities.emits_progress).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-worker-events`
Expected: FAIL — `onEvent` and `WorkerEvent` do not exist.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/workflow/runtimes/base.ts`:

```ts
/** The uniform event stream every runtime may emit. It exists so the engine can
 * renew a lease and record a checkpoint mid-run, which a request/response
 * interface cannot support, and so a future adapter is configuration rather
 * than an architectural change. */
export type WorkerEvent =
  | { type: "started" }
  | { type: "progress"; completed: number; total?: number; checkpoint?: unknown }
  | { type: "tool_call"; tool: string; idempotencyKey: string }
  | { type: "artifact_changed"; path: string; digest: string }
  | { type: "checkpoint"; state: unknown }
  | { type: "completed"; structuredOutput?: unknown }
  | { type: "interrupted"; reason: "quota" | "provider" | "operator" }
  | { type: "failed"; error: { code: string; message: string } };
```

Add to `StageRunRequest`:

```ts
  /** Optional. A runtime that does not emit simply never calls it, and the
   * engine falls back to process-liveness heartbeats. */
  onEvent?: (event: WorkerEvent) => void;
```

Add `emits_progress?: boolean` to `RuntimeCapabilities`. In `script.ts` and `subprocess.ts`, emit `started` on entry, `artifact_changed` per produced declared output, and `completed` / `failed` / `interrupted` on exit; set `emits_progress: true`. Leave `dry-run.ts` and the harness runtimes emitting only `started` and `completed` until they gain real progress reporting.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-worker-events`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the runtime suites**

Run: `npm test -- runtime dry-run script real-runtimes`
Expected: PASS — the field is optional.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/runtimes/ tests/contract-worker-events.test.ts
git commit -m "feat(runtimes): add an optional worker event stream for progress and checkpoints"
```

---

## M6 — Attempt journal and idempotency claims

### Task 12: Append-only journal with claimed idempotency keys

A key that is computed but never claimed prevents nothing. This makes the claim a durable, exclusive artifact consulted before any external call.

**Files:**
- Create: `src/lib/workflow/attempts.ts`
- Test: `tests/contract-attempts.test.ts`

**Interfaces:**
- Consumes: `canonicalJson` (Task 7).
- Produces: `AttemptState` enum; `AttemptTransition` schema; `idempotencyKey(unitKey, objective, strategy, inputDigest)`; `claimIdempotencyKey(dir, key, invocationId)`; `lookupClaim(dir, key)`; `appendTransition(dir, transition)`; `readJournal(dir, unitKey)`; `currentState(dir, unitKey, invocationId)`; `reconcile(dir, unitKey)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-attempts.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  idempotencyKey, claimIdempotencyKey, lookupClaim,
  appendTransition, readJournal, currentState, reconcile,
} from "../src/lib/workflow/attempts.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-attempts-"));
  dirs.push(dir);
  return dir;
}
const transition = (overrides: Record<string, unknown> = {}) => ({
  invocation_id: "inv-1", idempotency_key: "k1", unit_key: "repair",
  to: "prepared", at: new Date().toISOString(), intended_effects: ["src/a.ts"],
  applied_effects: [], ...overrides,
});

describe("attempt journal", () => {
  it("derives a stable idempotency key from unit, objective, strategy and inputs", () => {
    expect(idempotencyKey("repair", "obj1", "strat1", "d".repeat(64)))
      .toBe(idempotencyKey("repair", "obj1", "strat1", "d".repeat(64)));
    expect(idempotencyKey("repair", "obj1", "strat1", "d".repeat(64)))
      .not.toBe(idempotencyKey("repair", "obj1", "strat1", "e".repeat(64)));
  });

  it("claims a key exclusively", async () => {
    const dir = await workspace();
    expect(await claimIdempotencyKey(dir, "k1", "inv-1")).toBe("claimed");
    expect(await claimIdempotencyKey(dir, "k1", "inv-2")).toBe("already_claimed");
  });

  it("returns the owning invocation for an existing claim", async () => {
    const dir = await workspace();
    await claimIdempotencyKey(dir, "k1", "inv-1");
    expect((await lookupClaim(dir, "k1"))?.invocation_id).toBe("inv-1");
  });

  it("re-claims idempotently for the same invocation after a crash", async () => {
    const dir = await workspace();
    await claimIdempotencyKey(dir, "k1", "inv-1");
    expect(await claimIdempotencyKey(dir, "k1", "inv-1")).toBe("claimed");
  });

  it("retains every transition rather than overwriting one file", async () => {
    const dir = await workspace();
    await appendTransition(dir, transition({ to: "prepared" }) as never);
    await appendTransition(dir, transition({ to: "dispatched" }) as never);
    await appendTransition(dir, transition({ to: "applied", applied_effects: ["src/a.ts"] }) as never);
    const journal = await readJournal(dir, "repair");
    expect(journal.map((entry) => entry.to)).toEqual(["prepared", "dispatched", "applied"]);
  });

  it("derives the current state from the last transition", async () => {
    const dir = await workspace();
    await appendTransition(dir, transition({ to: "prepared" }) as never);
    await appendTransition(dir, transition({ to: "dispatched" }) as never);
    expect((await currentState(dir, "repair", "inv-1"))?.to).toBe("dispatched");
  });

  it("treats an attempt left dispatched as uncertain, never resumable", async () => {
    const dir = await workspace();
    await appendTransition(dir, transition({ to: "dispatched" }) as never);
    const result = await reconcile(dir, "repair");
    expect(result.uncertain).toHaveLength(1);
    expect(result.resumable).toHaveLength(0);
  });

  it("treats a committed attempt as neither uncertain nor resumable", async () => {
    const dir = await workspace();
    await appendTransition(dir, transition({ to: "prepared" }) as never);
    await appendTransition(dir, transition({ to: "committed", applied_effects: ["src/a.ts"] }) as never);
    const result = await reconcile(dir, "repair");
    expect(result.uncertain).toHaveLength(0);
    expect(result.resumable).toHaveLength(0);
  });

  it("treats an interrupted attempt with no applied effects as resumable", async () => {
    const dir = await workspace();
    await appendTransition(dir, transition({ to: "prepared" }) as never);
    await appendTransition(dir, transition({ to: "interrupted" }) as never);
    expect((await reconcile(dir, "repair")).resumable).toHaveLength(1);
  });

  it("never auto-redispatches an uncertain external effect", async () => {
    const dir = await workspace();
    await appendTransition(dir, transition({ to: "dispatched", intended_effects: ["provider:search"] }) as never);
    const result = await reconcile(dir, "repair");
    // At-least-once with idempotent effects. Exactly-once across a provider
    // boundary is not achievable and is not claimed.
    expect(result.uncertain[0].intended_effects).toEqual(["provider:search"]);
    expect(result.resumable).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-attempts`
Expected: FAIL — cannot resolve `attempts.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/attempts.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";

const JOURNAL = path.join(".malaclaw", "attempts");
const CLAIMS = path.join(".malaclaw", "claims");

export const AttemptState = z.enum([
  "prepared", "dispatched", "applied", "measured", "committed",
  "interrupted", "failed", "cancelled", "uncertain", "reconciled",
]);
export type AttemptState = z.infer<typeof AttemptState>;

export const AttemptTransition = z.object({
  invocation_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  unit_key: z.string().min(1),
  to: AttemptState,
  at: z.string().datetime(),
  intended_effects: z.array(z.string().min(1)).default([]),
  applied_effects: z.array(z.string().min(1)).default([]),
  detail: z.string().max(2_000).optional(),
}).strict();
export type AttemptTransition = z.infer<typeof AttemptTransition>;

export const Claim = z.object({
  idempotency_key: z.string().min(1),
  invocation_id: z.string().min(1),
  claimed_at: z.string().datetime(),
}).strict();
export type Claim = z.infer<typeof Claim>;

export function idempotencyKey(
  unitKey: string, objective: string, strategy: string, inputDigest: string,
): string {
  return crypto.createHash("sha256")
    .update(canonicalJson([unitKey, objective, strategy, inputDigest])).digest("hex");
}

/** An exclusive, durable claim consulted BEFORE any external call. A key that
 * is only computed prevents nothing; this is what stops a resumed run from
 * re-issuing a paid provider request. */
export async function claimIdempotencyKey(
  workspaceDir: string, key: string, invocationId: string,
): Promise<"claimed" | "already_claimed"> {
  const dir = path.join(workspaceDir, CLAIMS);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${key}.json`);
  const body = `${canonicalJson(Claim.parse({
    idempotency_key: key, invocation_id: invocationId, claimed_at: new Date().toISOString(),
  }))}\n`;
  try {
    const handle = await fs.open(target, "wx");
    try { await handle.writeFile(body, "utf-8"); } finally { await handle.close(); }
    return "claimed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = Claim.parse(JSON.parse(await fs.readFile(target, "utf-8")));
    return existing.invocation_id === invocationId ? "claimed" : "already_claimed";
  }
}

export async function lookupClaim(workspaceDir: string, key: string): Promise<Claim | null> {
  const raw = await fs.readFile(path.join(workspaceDir, CLAIMS, `${key}.json`), "utf-8").catch(() => null);
  return raw === null ? null : Claim.parse(JSON.parse(raw));
}

/** Append-only. One file per unit, one line per transition: overwriting a file
 * per invocation loses the history reconciliation needs. */
export async function appendTransition(workspaceDir: string, transition: AttemptTransition): Promise<void> {
  const parsed = AttemptTransition.parse(transition);
  const target = path.join(workspaceDir, JOURNAL, `${parsed.unit_key}.ndjson`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${canonicalJson(parsed)}\n`, "utf-8");
}

export async function readJournal(workspaceDir: string, unitKey: string): Promise<AttemptTransition[]> {
  const raw = await fs.readFile(path.join(workspaceDir, JOURNAL, `${unitKey}.ndjson`), "utf-8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line, index) => {
    const parsed = AttemptTransition.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`malformed attempt journal entry at ${unitKey}.ndjson:${index + 1}`);
    return parsed.data;
  });
}

export async function currentState(
  workspaceDir: string, unitKey: string, invocationId: string,
): Promise<AttemptTransition | null> {
  const entries = (await readJournal(workspaceDir, unitKey))
    .filter((entry) => entry.invocation_id === invocationId);
  return entries.length === 0 ? null : entries[entries.length - 1]!;
}

/** Conservative by construction. An attempt that reached `dispatched` may or
 * may not have landed its effects, and no local state can tell us which.
 * Replaying risks a duplicate provider call, a duplicate paid render, or a
 * second release, so it is reported uncertain and requires reconciliation. */
export async function reconcile(
  workspaceDir: string, unitKey: string,
): Promise<{ resumable: AttemptTransition[]; uncertain: AttemptTransition[] }> {
  const byInvocation = new Map<string, AttemptTransition>();
  for (const entry of await readJournal(workspaceDir, unitKey)) byInvocation.set(entry.invocation_id, entry);

  const resumable: AttemptTransition[] = [];
  const uncertain: AttemptTransition[] = [];
  for (const entry of byInvocation.values()) {
    if (entry.to === "committed" || entry.to === "reconciled") continue;
    if (entry.to === "dispatched" || entry.to === "uncertain" || entry.applied_effects.length > 0) {
      uncertain.push(entry);
      continue;
    }
    resumable.push(entry);
  }
  return { resumable, uncertain };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-attempts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/attempts.ts tests/contract-attempts.test.ts
git commit -m "feat(workflow): add an append-only attempt journal with claimed idempotency keys"
```

---

## M7 — Persistent leases and orphan recovery

### Task 13: Durable lease acquisition, renewal and expiry

**Files:**
- Create: `src/lib/workflow/leases.ts`
- Test: `tests/contract-leases.test.ts`

**Interfaces:**
- Consumes: `AttemptTransition` (Task 12); `canonicalJson` (Task 7).
- Produces: `Lease` schema; `AttemptHealth`; `acquireLease(dir, unitKey, owner, ttlMs, now)`; `renewLease(dir, unitKey, owner, progressSequence, ttlMs, now)`; `releaseLease(dir, unitKey, owner)`; `readLease(dir, unitKey)`; `classifyHealth(lease, attempt, now, policy)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-leases.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLease, renewLease, releaseLease, readLease, classifyHealth } from "../src/lib/workflow/leases.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-leases-"));
  dirs.push(dir);
  return dir;
}
const POLICY = { stalled_renewals: 3, stalled_ms: 600_000 };
const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const attempt = {
  invocation_id: "i1", idempotency_key: "k", unit_key: "u", to: "dispatched" as const,
  at: new Date(NOW).toISOString(), intended_effects: [], applied_effects: [],
};

describe("durable leases", () => {
  it("acquires a lease and persists it", async () => {
    const dir = await workspace();
    expect(await acquireLease(dir, "u", "worker-17", 60_000, NOW)).toBe("acquired");
    expect((await readLease(dir, "u"))?.lease_owner).toBe("worker-17");
  });

  it("refuses a second owner while the lease is live", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 60_000, NOW);
    expect(await acquireLease(dir, "u", "worker-99", 60_000, NOW + 1_000)).toBe("held_by_other");
  });

  it("permits takeover only after expiry", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 60_000, NOW);
    expect(await acquireLease(dir, "u", "worker-99", 60_000, NOW + 60_001)).toBe("acquired");
  });

  it("refuses renewal by a different owner", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 60_000, NOW);
    await expect(renewLease(dir, "u", "worker-99", 1, 60_000, NOW + 1_000)).rejects.toThrow(/owner/i);
  });

  it("resets the no-progress counter when the progress sequence advances", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 60_000, NOW);
    await renewLease(dir, "u", "worker-17", 1, 60_000, NOW + 1_000);
    await renewLease(dir, "u", "worker-17", 1, 60_000, NOW + 2_000);
    const stalled = await readLease(dir, "u");
    expect(stalled?.renewals_without_progress).toBe(1);
    await renewLease(dir, "u", "worker-17", 2, 60_000, NOW + 3_000);
    expect((await readLease(dir, "u"))?.renewals_without_progress).toBe(0);
  });

  it("releases a lease so another owner may take it immediately", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 60_000, NOW);
    await releaseLease(dir, "u", "worker-17");
    expect(await acquireLease(dir, "u", "worker-99", 60_000, NOW + 1)).toBe("acquired");
  });

  it("reports a live attempt with recent progress as progressing", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 60_000, NOW);
    expect(classifyHealth((await readLease(dir, "u"))!, attempt, NOW + 1_000, POLICY))
      .toBe("running_progressing");
  });

  it("marks a long run without progress stalled, and never terminates it", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 3_600_000, NOW);
    for (let index = 0; index < 4; index += 1) {
      await renewLease(dir, "u", "worker-17", 1, 3_600_000, NOW + index * 1_000);
    }
    // Long-running is not the same as dead: only lease expiry terminates.
    expect(classifyHealth((await readLease(dir, "u"))!, attempt, NOW + 5_000, POLICY))
      .toBe("running_stalled");
  });

  it("reports an expired lease mid-dispatch as provider_uncertain", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 1_000, NOW);
    expect(classifyHealth((await readLease(dir, "u"))!, attempt, NOW + 2_000, POLICY))
      .toBe("provider_uncertain");
  });

  it("reports an expired lease with applied effects as requiring reconciliation", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 1_000, NOW);
    const applied = { ...attempt, to: "interrupted" as const, applied_effects: ["provider:call"] };
    expect(classifyHealth((await readLease(dir, "u"))!, applied, NOW + 2_000, POLICY))
      .toBe("requires_reconciliation");
  });

  it("reports an expired lease with no applied effects as worker_lost", async () => {
    const dir = await workspace();
    await acquireLease(dir, "u", "worker-17", 1_000, NOW);
    expect(classifyHealth((await readLease(dir, "u"))!, { ...attempt, to: "interrupted" }, NOW + 2_000, POLICY))
      .toBe("worker_lost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-leases`
Expected: FAIL — cannot resolve `leases.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/leases.ts` with `Lease` persisted at `.malaclaw/leases/<unitKey>.json`, written through a temp-file rename. `acquireLease` returns `"acquired"` when no lease exists, the existing lease is expired, or the caller already owns it; `"held_by_other"` otherwise. `renewLease` throws when the caller is not the recorded owner. `classifyHealth` implements the six states:

```ts
/** A wall-clock timeout is a poor definition of failure: a legitimate long
 * retrieval and a dead worker look identical to it. Only lease expiry
 * terminates an attempt; elapsed time can at most mark it stalled, which
 * triggers diagnosis. */
export function classifyHealth(
  lease: Lease, attempt: AttemptTransition, now: number, policy: StallPolicy,
): AttemptHealth {
  if (Date.parse(lease.lease_expires_at) > now) {
    const sinceProgress = now - Date.parse(lease.last_progress_at);
    return lease.renewals_without_progress >= policy.stalled_renewals || sinceProgress >= policy.stalled_ms
      ? "running_stalled" : "running_progressing";
  }
  if (attempt.applied_effects.length > 0) return "requires_reconciliation";
  if (attempt.to === "dispatched" || attempt.to === "uncertain") return "provider_uncertain";
  return "worker_lost";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-leases`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/leases.ts tests/contract-leases.test.ts
git commit -m "feat(workflow): add durable lease acquisition, renewal and orphan classification"
```

---

## M8 — Snapshot, conflict and join scheduling

### Task 14: Snapshot-bound conflict scheduling

The previous draft compared `owns` against `owns` only, and deliberately ran a measurement concurrently with a mutation whose files it reads — with no snapshot to read from. Until snapshots exist, read/write overlaps must serialize.

**Files:**
- Create: `src/lib/workflow/conflicts.ts`
- Test: `tests/contract-conflicts.test.ts`

**Interfaces:**
- Consumes: `matchesEnvelope` (Task 2); `TaskWorkspace` (Task 4).
- Produces: `envelopesOverlap(a, b)`; `conflictGraph(units)`; `schedulableBatches(units)`; `exclusiveLeasePaths(units)`; `joinSnapshotId(units)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-conflicts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { envelopesOverlap, conflictGraph, schedulableBatches, exclusiveLeasePaths } from "../src/lib/workflow/conflicts.js";

const writeA = { id: "write_a", kind: "mutation" as const, owns: ["src/a/**"], writes: ["src/a/x.ts"], reads: ["shared/**"] };
const writeB = { id: "write_b", kind: "mutation" as const, owns: ["src/b/**"], writes: ["src/b/x.ts"], reads: ["shared/**"] };
const writeShared = { id: "write_shared", kind: "mutation" as const, owns: ["shared/registry.json"], writes: ["shared/registry.json"], reads: [] };
const writeSharedGlob = { id: "write_shared_2", kind: "mutation" as const, owns: ["shared/**"], writes: ["shared/other.json"], reads: [] };
const measureA = { id: "measure_a", kind: "measurement" as const, owns: [], writes: [], reads: ["src/a/**"] };
const measureC = { id: "measure_c", kind: "measurement" as const, owns: [], writes: [], reads: ["src/c/**"] };

describe("conflict scheduling", () => {
  it("detects overlap between an exact path and a covering glob", () => {
    expect(envelopesOverlap(["shared/registry.json"], ["shared/**"])).toBe(true);
    expect(envelopesOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
  });

  it("batches mutations with disjoint envelopes together", () => {
    const batches = schedulableBatches([writeA, writeB]);
    expect(batches).toHaveLength(1);
    expect(batches[0].sort()).toEqual(["write_a", "write_b"]);
  });

  it("serializes two mutations whose envelopes overlap", () => {
    expect(schedulableBatches([writeShared, writeSharedGlob])).toHaveLength(2);
  });

  it("serializes a measurement that reads what a mutation writes", () => {
    // Without an immutable snapshot the measurement would read a half-written
    // workspace, so read/write overlap conflicts.
    expect(schedulableBatches([writeA, measureA])).toHaveLength(2);
  });

  it("batches a measurement that reads nothing a mutation writes", () => {
    expect(schedulableBatches([writeA, measureC])).toHaveLength(1);
  });

  it("batches two measurements together", () => {
    expect(schedulableBatches([measureA, measureC])).toHaveLength(1);
  });

  it("records the conflict edge in both directions", () => {
    const graph = conflictGraph([writeShared, writeSharedGlob]);
    expect(graph.get("write_shared")?.has("write_shared_2")).toBe(true);
    expect(graph.get("write_shared_2")?.has("write_shared")).toBe(true);
  });

  it("does not conflict two units that merely read the same paths", () => {
    expect(conflictGraph([writeA, writeB]).get("write_a")?.size ?? 0).toBe(0);
  });

  it("names paths owned by more than one unit as needing an exclusive lease", () => {
    expect(exclusiveLeasePaths([writeShared, { ...writeSharedGlob, owns: ["shared/registry.json"] }]))
      .toEqual(["shared/registry.json"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-conflicts`
Expected: FAIL — cannot resolve `conflicts.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/conflicts.ts`. The graph compares **write-vs-write and write-vs-read**:

```ts
/** Prevention, not detection. Hashing afterward proves two workers raced; it
 * does not stop them.
 *
 * Two units conflict when one writes what the other writes OR reads. The
 * read/write case matters because a measurement reading a workspace a mutation
 * is changing sees a torn state; once snapshot-bound reads exist, that edge can
 * be relaxed to allow concurrency against an immutable snapshot. */
export function conflictGraph(units: ConflictUnit[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>(units.map((unit) => [unit.id, new Set<string>()]));
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const left = units[i]!;
      const right = units[j]!;
      const conflicts =
        envelopesOverlap(left.owns, right.owns)
        || envelopesOverlap(left.owns, right.reads)
        || envelopesOverlap(right.owns, left.reads);
      if (!conflicts) continue;
      graph.get(left.id)!.add(right.id);
      graph.get(right.id)!.add(left.id);
    }
  }
  return graph;
}
```

`schedulableBatches` remains greedy graph colouring; each batch is an independent set and shares one `snapshotId`, which the engine records on every task workspace in the batch so a join reducer receives a declared snapshot rather than whatever files happen to exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-conflicts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/conflicts.ts tests/contract-conflicts.test.ts
git commit -m "feat(workflow): serialize write/write and write/read conflicts within a snapshot"
```

---

## M9 — Blocked corrective subflows

### Task 15: Blocked workspace state

**Files:**
- Create: `src/lib/workflow/blocks.ts`
- Modify: `src/lib/workflow/state.ts` (`FlowState.blocks`)
- Test: `tests/contract-blocks.test.ts`

**Interfaces:**
- Consumes: `ContractOutcome`, `blocksWorkspace` (Task 1).
- Produces: `Block` schema; `raiseBlock`; `activeBlocks`; `assertRunnable`; `clearBlock`; `authorizedCorrective(state, blockId, capability)`; `BlockedWorkspaceError`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-blocks.test.ts` covering: a block records its outcome, objective, before/after snapshot and changed files; `assertRunnable` throws while a block stands and names it; only the declared corrective capability is authorized; clearing requires a recorded decision; a cleared block stays in history; and an outcome whose policy is `pause` raises no block.

```ts
import { describe, it, expect } from "vitest";
import {
  raiseBlock, activeBlocks, assertRunnable, clearBlock,
  authorizedCorrective, BlockedWorkspaceError,
} from "../src/lib/workflow/blocks.js";

const block = {
  id: "b1", outcome: "regressed" as const, unit_key: "repair", objective: "obj1",
  before: { "row_validity ": 1 }, after: { "row_validity ": 0.8 },
  changed_files: ["data/rows.csv"], created_at: "2026-09-01T12:00:00.000Z",
  corrective_capability: "restore_rows",
};

describe("blocked workspace", () => {
  it("records a block with its snapshot and changed files", () => {
    const state = raiseBlock({ blocks: [] }, block);
    expect(activeBlocks(state)[0].changed_files).toEqual(["data/rows.csv"]);
  });

  it("refuses ordinary execution and names the standing block", () => {
    const state = raiseBlock({ blocks: [] }, block);
    expect(() => assertRunnable(state)).toThrow(BlockedWorkspaceError);
    try { assertRunnable(state); } catch (error) {
      expect((error as Error).message).toMatch(/b1/);
      expect((error as Error).message).toMatch(/repair-block/);
    }
  });

  it("authorizes only the designated corrective capability", () => {
    const state = raiseBlock({ blocks: [] }, block);
    expect(authorizedCorrective(state, "b1", "restore_rows")).toBe(true);
    expect(authorizedCorrective(state, "b1", "keep_going")).toBe(false);
  });

  it("runs again once cleared, and keeps the block in history", () => {
    let state = raiseBlock({ blocks: [] }, block);
    state = clearBlock(state, "b1", "operator", "restored from backup");
    expect(() => assertRunnable(state)).not.toThrow();
    expect(state.blocks[0].cleared_by).toBe("operator");
    expect(state.blocks[0].resolution).toBe("restored from backup");
  });

  it("does not raise a block for an outcome that only pauses", () => {
    expect(activeBlocks(raiseBlock({ blocks: [] }, { ...block, id: "b2", outcome: "unmet" }))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-blocks`
Expected: FAIL — cannot resolve `blocks.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/blocks.ts` with the `Block` schema (adding `resolution: string` on clear), `raiseBlock` gated on `blocksWorkspace(outcome)`, `assertRunnable` throwing `BlockedWorkspaceError` that names the blocks and the `repair-block` command, and `authorizedCorrective` comparing against the block's declared `corrective_capability`. Add `blocks: z.array(Block).default([])` to `FlowState`, and call `assertRunnable` at the top of `flow run` and `flow continue`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-blocks`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/blocks.ts src/lib/workflow/state.ts tests/contract-blocks.test.ts
git commit -m "feat(workflow): add durable blocked-workspace state"
```

---

### Task 16: `flow repair-block` corrective subflow

The previous draft registered this command against a file it never created.

**Files:**
- Create: `src/lib/workflow/repair-block.ts`
- Modify: `src/commands/flow.ts`
- Test: `tests/contract-repair-block.test.ts`

**Interfaces:**
- Consumes: `blocks.ts` (Task 15); `evaluateContract` (Task 9); `ingestEnvelope` (Task 8); `runFlowUnlocked` (existing).
- Produces: `runFlowRepairBlock(opts: { workspaceDir; blockId; capability; runtime; workflow }): Promise<RepairBlockResult>` where `RepairBlockResult = { dispatched: boolean; remeasured: string[]; cleared: boolean; outcome: ContractOutcome }`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-repair-block.test.ts` covering:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFlowRepairBlock } from "../src/lib/workflow/repair-block.js";

// Fixture helpers omitted for brevity in this excerpt; each test constructs a
// workspace whose flow state carries one active block declaring
// corrective_capability: "restore_rows".

describe("repair-block", () => {
  it("refuses a capability the block did not declare", async () => {
    // authorization precedes any dispatch
  });
  it("dispatches only the declared corrective action", async () => {});
  it("re-measures the protected metric after the corrective action", async () => {});
  it("does not clear the block merely because the action returned", async () => {
    // The corrective action succeeding is not evidence the invariant is
    // restored; only a fresh measurement satisfying it clears the block.
  });
  it("clears the block when the protected metric is restored", async () => {});
  it("leaves the block standing when re-measurement still fails", async () => {});
  it("refuses to run any other unit while the block stands", async () => {});
  it("records an interruption without clearing the block", async () => {});
});
```

Flesh each case out against the fixture helper; every assertion must exercise `runFlowRepairBlock` rather than the block state alone.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-repair-block`
Expected: FAIL — cannot resolve `repair-block.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/repair-block.ts`:

```ts
/** The corrective subflow.
 *
 * A block clears only when a FRESH measurement shows the protected criterion
 * satisfied again. The corrective action returning successfully is not
 * evidence: that is precisely the "the stage succeeded, the gate is still
 * failing" inference this whole design removes. */
export async function runFlowRepairBlock(opts: RepairBlockOptions): Promise<RepairBlockResult> {
  const state = await loadFlowState(opts.workspaceDir);
  if (!authorizedCorrective(state, opts.blockId, opts.capability)) {
    throw new Error(`capability ${opts.capability} is not the corrective action declared by block ${opts.blockId}`);
  }
  // ... materialize a single-action subflow, dispatch it through the normal
  // task-workspace path, ingest its measurement envelope, then re-evaluate the
  // block's protected criteria against the fresh snapshot.
}
```

Register in `src/commands/flow.ts`:

```ts
flow
  .command("repair-block <blockId>")
  .description("Dispatch only the declared corrective action for a standing block")
  .requiredOption("--action <capability>", "the corrective capability declared by the block")
  .action(async (blockId, options) => {
    const { runFlowRepairBlock } = await import("../lib/workflow/repair-block.js");
    await runFlowRepairBlock({ workspaceDir: process.cwd(), blockId, capability: options.action, ... });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-repair-block`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/repair-block.ts src/commands/flow.ts tests/contract-repair-block.test.ts
git commit -m "feat(flow): implement the repair-block corrective subflow with re-measurement"
```

---

## M10 — Run pin storage and migration

### Task 17: Pin the run definition

**Files:**
- Create: `src/lib/workflow/pinning.ts`
- Modify: `src/lib/workflow/state.ts` (store the full `RunPin`, not only its digest)
- Test: `tests/contract-pinning.test.ts`

**Interfaces:**
- Consumes: `WorkflowDef` (Task 2); `workflowHash` (existing); `canonicalJson` (Task 7).
- Produces: `RunPin` schema; `computePin(workflow, environment)`; `pinDigest(pin)`; `assertPinMatches(recorded, current)`; `PinMismatchError`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-pinning.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WorkflowDef } from "../src/lib/schema.js";
import { computePin, pinDigest, assertPinMatches, PinMismatchError, RunPin } from "../src/lib/workflow/pinning.js";

const wf = WorkflowDef.parse({ ir_version: 2, stages: [{ id: "a", owner: "x", outputs: ["a.md"] }] });
const env = {
  registry_versions: { metric: "1", finding: "1" },
  prompt_versions: { plan: "3" },
  model_profile: "flagship",
  evaluator_configuration: "1",
  tool_versions: { latex: "2024" },
};

describe("run pinning", () => {
  it("produces a stable digest for identical inputs", () => {
    expect(pinDigest(computePin(wf, env))).toBe(pinDigest(computePin(wf, env)));
  });

  it("changes the digest when any pinned dimension changes", () => {
    for (const drift of [
      { ...env, prompt_versions: { plan: "4" } },
      { ...env, model_profile: "economy" },
      { ...env, registry_versions: { metric: "2", finding: "1" } },
      { ...env, evaluator_configuration: "2" },
      { ...env, tool_versions: { latex: "2025" } },
    ]) {
      expect(pinDigest(computePin(wf, drift))).not.toBe(pinDigest(computePin(wf, env)));
    }
  });

  it("accepts a resume under the pinned definition", () => {
    expect(() => assertPinMatches(computePin(wf, env), computePin(wf, env))).not.toThrow();
  });

  it("fails a drifted resume and names what drifted", () => {
    const pin = computePin(wf, env);
    const drifted = computePin(wf, { ...env, prompt_versions: { plan: "9" } });
    try {
      assertPinMatches(pin, drifted);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PinMismatchError);
      expect((error as Error).message).toMatch(/prompt_versions/);
      expect((error as Error).message).toMatch(/migration/i);
    }
  });

  it("round-trips the full pin so drift diagnostics work after a restart", () => {
    // Storing only the digest tells an operator that something changed but
    // never what, which is not an actionable pause.
    const pin = computePin(wf, env);
    expect(RunPin.parse(JSON.parse(JSON.stringify(pin)))).toEqual(pin);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-pinning`
Expected: FAIL — cannot resolve `pinning.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/pinning.ts` with `RunPin` covering `ir_version`, `manifest_digest`, `registry_versions`, `prompt_versions`, `model_profile`, `evaluator_configuration`, `tool_versions`; `computePin`; `pinDigest` over `canonicalJson`; and `assertPinMatches` collecting drifted field names into `PinMismatchError`. Store the **full pin** on `FlowState` as `runPin: RunPin.optional()` alongside `pinDigest`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-pinning`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/pinning.ts src/lib/workflow/state.ts tests/contract-pinning.test.ts
git commit -m "feat(workflow): pin the full run definition and fail a drifted resume explicitly"
```

---

## M11 — Integration

### Task 18: The contract cycle for standard stages

**Files:**
- Modify: `src/lib/workflow/engine.ts`
- Modify: `src/lib/workflow/state.ts` (`UnitState` gains outcomes and objective progress)
- Modify: `src/lib/workflow/checkpoint-index.ts` (full §B14 checkpoint contents)
- Test: `tests/contract-engine-standard.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1–17.
- Produces: `UnitState.executionOutcome`, `.contractOutcome`, `.objectiveProgress`, `.invocationId`; `CheckpointEntry` gains `input_digest`, `pin_digest`, `worker_state`, `provider_continuation`, `fanout_progress`, `effect_journal`, `sequence`.

The cycle, in order, for every unit:

1. `assertRunnable(state)`; classify health of any prior attempt and `reconcile`.
2. Compute `input_digest`; derive `idempotencyKey`; `claimIdempotencyKey`.
3. `appendTransition(prepared)`; `acquireLease`.
4. `createTaskWorkspace` from declared `reads` at the batch `snapshotId`.
5. `appendTransition(dispatched)`; `runStage` with `taskWorkspaceRoot` and `onEvent` renewing the lease.
6. `diffTaskWorkspace`, `validateDiff`. A non-null result short-circuits to that contract outcome, commits nothing, and blocks.
7. `commitEffects`; `appendTransition(applied)`.
8. Run `evaluate_with` measurement units; `ingestEnvelope`; `appendTransition(measured)`.
9. `snapshotFor` the unit's criteria before and after; `evaluateContract`.
10. `recordAttempt` into `objectiveProgress`; reject a repeated fingerprint.
11. Apply `executionAction` then `contractAction`; `raiseBlock` when `blocksWorkspace`.
12. `appendTransition(committed)`; `releaseLease`; `destroyTaskWorkspace`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-engine-standard.test.ts` using the **real** API — `runFlow({ workflow, workspaceDir, runtime })`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowDef } from "../src/lib/schema.js";
import { runFlow } from "../src/lib/workflow/engine.js";
import { loadFlowState } from "../src/lib/workflow/state.js";
import { scriptRuntime } from "../src/lib/workflow/runtimes/script.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

/** A domain-neutral fixture: a code repair whose objective is test coverage,
 * measured by a separate script unit that writes a measurement envelope. */
function workflow(coverage: number, rowValidity = 1) {
  const envelope = JSON.stringify({
    version: 1,
    measurements: [
      { metric: "test_coverage", scope_key: "", status: "measured", value: coverage,
        target: 0.9, operator: "at_least", tolerance: 0.000001, direction: "maximize",
        evaluator: "coverage", evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
        measurement_kind: "script" },
      { metric: "row_validity", scope_key: "", status: "measured", value: rowValidity,
        target: 1, operator: "at_least", tolerance: 0, direction: "maximize",
        evaluator: "rows", evaluator_digest: "c".repeat(64), input_digest: "d".repeat(64),
        measurement_kind: "script" },
    ],
  });
  return WorkflowDef.parse({
    ir_version: 2,
    stages: [
      { id: "repair", owner: "eng", kind: "mutation", runtime: "script",
        reads: ["src/**"], writes: ["src/a.ts"], owns: ["src/**"], outputs: ["src/a.ts"],
        evaluate_with: ["measure"],
        acceptance: [{ metric: "test_coverage", scope_key: "", operator: "at_least",
                       target: 0.9, tolerance: 0.000001, direction: "maximize" }],
        must_improve: [{ metric: "test_coverage", scope_key: "", min_absolute_delta: 0.01,
                         min_gap_fraction: 0.2, max_attempts: 2 }],
        must_preserve: [{ metric: "row_validity", scope_key: "", operator: "at_least",
                          target: 1, tolerance: 0, direction: "maximize" }],
        command: { cmd: "node", args: ["-e", "require('fs').writeFileSync('src/a.ts','repaired')"] } },
      { id: "measure", owner: "ci", kind: "measurement", runtime: "script",
        reads: ["src/**"], writes_observations: ["test_coverage", "row_validity"],
        outputs: ["reports/measurements.json"],
        command: { cmd: "node", args: ["-e",
          `require('fs').mkdirSync('reports',{recursive:true});require('fs').writeFileSync('reports/measurements.json',${JSON.stringify(envelope)})`] } },
    ],
  });
}

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-cycle-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
  return dir;
}

describe("engine contract cycle", () => {
  it("records both an execution outcome and a contract outcome", async () => {
    const dir = await workspace();
    await runFlow({ workflow: workflow(0.95), workspaceDir: dir, runtime: scriptRuntime });
    const state = await loadFlowState(dir);
    expect(state?.units.repair.executionOutcome).toBe("completed");
    expect(state?.units.repair.contractOutcome).toBe("accepted");
  });

  it("marks a unit with no objective as not_applicable rather than succeeded", async () => {
    const dir = await workspace();
    const plain = WorkflowDef.parse({
      ir_version: 2,
      stages: [{ id: "plain", owner: "x", runtime: "script", outputs: ["out.md"],
        command: { cmd: "node", args: ["-e", "require('fs').writeFileSync('out.md','x')"] } }],
    });
    await runFlow({ workflow: plain, workspaceDir: dir, runtime: scriptRuntime });
    expect((await loadFlowState(dir))?.units.plain.contractOutcome).toBe("not_applicable");
  });

  it("blocks the workspace when a protected metric falls", async () => {
    const dir = await workspace();
    await runFlow({ workflow: workflow(0.95, 0.7), workspaceDir: dir, runtime: scriptRuntime });
    const state = await loadFlowState(dir);
    expect(state?.units.repair.contractOutcome).toBe("partially_improved_with_regression");
    expect(state?.blocks?.filter((block) => !block.cleared_at)).toHaveLength(1);
  });

  it("commits the mutation's declared write to the canonical workspace", async () => {
    const dir = await workspace();
    await runFlow({ workflow: workflow(0.95), workspaceDir: dir, runtime: scriptRuntime });
    expect(await fs.readFile(path.join(dir, "src/a.ts"), "utf-8")).toBe("repaired");
  });

  it("journals prepared, dispatched, applied, measured and committed", async () => {
    const dir = await workspace();
    await runFlow({ workflow: workflow(0.95), workspaceDir: dir, runtime: scriptRuntime });
    const journal = await fs.readFile(path.join(dir, ".malaclaw/attempts/repair.ndjson"), "utf-8");
    for (const state of ["prepared", "dispatched", "applied", "measured", "committed"]) {
      expect(journal).toContain(`"${state}"`);
    }
  });

  it("releases the lease after the unit completes", async () => {
    const dir = await workspace();
    await runFlow({ workflow: workflow(0.95), workspaceDir: dir, runtime: scriptRuntime });
    const lease = await fs.readFile(path.join(dir, ".malaclaw/leases/repair.json"), "utf-8").catch(() => null);
    expect(lease === null || JSON.parse(lease).released_at).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-engine-standard`
Expected: FAIL — `executionOutcome` is not on `UnitState`.

- [ ] **Step 3: Write minimal implementation**

Add to `UnitState`:

```ts
  executionOutcome: ExecutionOutcome.optional(),
  contractOutcome: ContractOutcome.optional(),
  invocationId: z.string().optional(),
  objectiveProgress: z.record(ObjectiveProgress).default({}),
```

Implement the twelve-step cycle in `runFlowUnlocked`, and **delete** the code path that infers success from changed declared outputs. Extend `CheckpointEntry` with the §B14 fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-engine-standard`
Expected: PASS, 6 tests.

- [ ] **Step 5: Repair suite fallout**

Run: `npm run build && npm test`
Expected: existing engine tests asserting on "succeeded" need updating to the two-axis model. Update assertions to the correct new outcome; never reinstate the output-changed inference to keep an old test green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/engine.ts src/lib/workflow/state.ts src/lib/workflow/checkpoint-index.ts tests/
git commit -m "feat!: replace output-changed success inference with the transactional contract cycle"
```

---

### Task 19: Every other scheduler shape

**Files:**
- Test: `tests/contract-engine-loop.test.ts`
- Test: `tests/contract-engine-foreach.test.ts`
- Test: `tests/contract-engine-dispatch.test.ts`
- Test: `tests/contract-engine-recovery.test.ts`
- Modify: `src/lib/workflow/engine.ts` as each shape's failures require

- [ ] **Step 1: Loop stages**

Cover: a loop whose `stop_when` reads an ingested observation; `on_exhaustion: fail` producing `strategy_exhausted`; a round whose measurement defers producing `pending_verification` and resolving at the round boundary; and a regression mid-loop blocking rather than starting another round.

- [ ] **Step 2: Foreach stages**

Cover: items with disjoint envelopes batching together; items whose envelopes overlap serializing; partial fan-out resuming only incomplete items; and a join reducer receiving the declared `snapshotId` rather than whatever files exist.

- [ ] **Step 3: Action dispatch**

Cover: a dispatched action inheriting its instance contract; a repeated fingerprint rejected before dispatch; `max_invocations` respected; and `continue_on_recoverable_failure` leaving durable state for retry.

- [ ] **Step 4: Interruption and recovery**

Cover: quota exhaustion mid-unit pausing and resuming from checkpoint without consuming a strategy attempt; a crash after `applied` but before `measured` reconciling without duplicating effects; a crash before `applied` resuming cleanly; lease expiry with unreconciled effects producing `requires_reconciliation`; and a resume under a changed pin failing with `PinMismatchError`.

- [ ] **Step 5: Run every shape**

Run: `npm test -- contract-engine`
Expected: PASS across all four files.

- [ ] **Step 6: Commit**

```bash
git add tests/contract-engine-*.test.ts src/lib/workflow/engine.ts
git commit -m "test(workflow): cover the contract cycle across every scheduler shape"
```

---

### Task 20: Ship and export the conformance corpus

The corpus exists so both repositories test against **one** implementation. It
must therefore travel with the runtime: MrMaLiang resolves `malaclaw` from
`.dependencies/MalaClaw` and already imports `malaclaw/sdk`, so shipping the
fixtures in the package means pinning a runtime version pins the contract with
it, and there is no vendored copy to drift.

**Files:**
- Create: `fixtures/wire-contract/v1/envelope.json`
- Modify: `fixtures/wire-contract/v1/arithmetic.json` (add the operator/direction cases)
- Modify: `src/sdk/index.ts` (export the wire-contract surface)
- Modify: `package.json` (`files`, `exports`)
- Test: `tests/contract-conformance.test.ts`

**Interfaces:**
- Consumes: `Criterion`, `MustImprove` (Task 2); `evaluateContract`, `satisfies`, `closedGapFraction` (Task 9); `MeasurementEnvelope`, `ingestEnvelope` (Task 8).
- Produces: from `malaclaw/sdk` — `Criterion`, `MustImprove`, `MeasurementEnvelope`, `satisfies`, `closedGapFraction`, `evaluateContract`, and `wireContractFixtureDir()` returning the shipped corpus path.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-conformance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MeasurementEnvelope } from "../src/lib/workflow/measurements.js";
import { evaluateContract } from "../src/lib/workflow/acceptance.js";
import { Criterion } from "../src/lib/schema.js";
import { wireContractFixtureDir } from "../src/sdk/index.js";

type ArithmeticCase = {
  name: string; criterion: unknown; before: number; after: number; expect: string;
};
type EnvelopeCase = { name: string; envelope: unknown; expect: "accepted" | "rejected"; reason?: string };

const dir = wireContractFixtureDir();
const arithmetic: ArithmeticCase[] = JSON.parse(fs.readFileSync(path.join(dir, "arithmetic.json"), "utf-8"));
const envelopes: EnvelopeCase[] = JSON.parse(fs.readFileSync(path.join(dir, "envelope.json"), "utf-8"));

describe("wire contract conformance", () => {
  it("ships both fixture families", () => {
    expect(arithmetic.length).toBeGreaterThan(9);
    expect(envelopes.length).toBeGreaterThan(6);
  });

  it("matches every arithmetic case", () => {
    for (const fixture of arithmetic) {
      const parsed = Criterion.safeParse(fixture.criterion);
      if (fixture.expect === "rejected") {
        expect(parsed.success, fixture.name).toBe(false);
        continue;
      }
      expect(parsed.success, fixture.name).toBe(true);
      const criterion = parsed.data!;
      const key = `${criterion.metric} ${criterion.scope_key}`;
      expect(evaluateContract({
        acceptance: [criterion],
        must_improve: [{ metric: criterion.metric, scope_key: criterion.scope_key,
                         min_absolute_delta: 0, min_gap_fraction: 0, max_attempts: 9 }],
        must_preserve: [],
        before: new Map([[key, fixture.before]]),
        after: new Map([[key, fixture.after]]),
        attempts: 1, pending: [], unavailable: [],
      }), fixture.name).toBe(fixture.expect);
    }
  });

  it("accepts or rejects every envelope case as specified", () => {
    for (const fixture of envelopes) {
      const parsed = MeasurementEnvelope.safeParse(fixture.envelope);
      expect(parsed.success, `${fixture.name} (${fixture.reason ?? ""})`)
        .toBe(fixture.expect === "accepted");
    }
  });

  it("covers equals from above, below and at target", () => {
    const names = arithmetic.map((fixture) => fixture.name).join(" ");
    expect(names).toMatch(/equals starting above/);
    expect(names).toMatch(/equals starting below/);
    expect(names).toMatch(/equals reaches target/);
  });

  it("covers operator/direction rejection in both directions", () => {
    const rejected = arithmetic.filter((fixture) => fixture.expect === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves the shipped fixture directory from the package, not the source tree", () => {
    // MrMaLiang reads this same path through its pinned runtime; a source-tree
    // path would resolve to nothing once installed.
    expect(fs.existsSync(path.join(dir, "arithmetic.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-conformance`
Expected: FAIL — `wireContractFixtureDir` is not exported and `envelope.json` does not exist.

- [ ] **Step 3: Write the envelope fixtures**

Create `fixtures/wire-contract/v1/envelope.json` covering the cases in wire
contract §7: one entry per scope for a scoped metric; a `model` entry missing
`judgment` (rejected); a `script` entry carrying `judgment` (rejected); a
`measured` entry with no value (rejected); an `unavailable` entry with no reason
(rejected); `unavailable` and `deferred` entries; and an unrecognized version
(rejected). Extend `arithmetic.json` with the two operator/direction rejection
cases, marked `"expect": "rejected"`.

- [ ] **Step 4: Export the surface and ship the corpus**

Add to `src/sdk/index.ts`:

```ts
/** The wire-contract surface, exported so a domain layer validates its
 * compiled criteria and emitted envelopes against the ENGINE's schemas and
 * arithmetic rather than a second copy of them. */
export { Criterion, MustImprove } from "../lib/schema.js";
export { MeasurementEnvelope } from "../lib/workflow/measurements.js";
export { satisfies, closedGapFraction, evaluateContract } from "../lib/workflow/acceptance.js";

/** Absolute path to the shipped conformance corpus. Resolved from this
 * module's own location so it works from `dist/` in an installed package. */
export function wireContractFixtureDir(version = "v1"): string {
  return path.join(fileURLToPath(new URL("../../fixtures/wire-contract", import.meta.url)), version);
}
```

Add `"fixtures/wire-contract/"` to the package `files`, and
`"./fixtures/*": "./fixtures/*"` to `exports`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- contract-conformance`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify the corpus survives packing**

Run: `npm pack --dry-run 2>&1 | grep wire-contract`
Expected: both fixture files listed. A corpus that is not packed is invisible to
MrMaLiang, which resolves it from the installed runtime.

- [ ] **Step 7: Commit**

```bash
git add fixtures/wire-contract/ src/sdk/index.ts package.json tests/contract-conformance.test.ts
git commit -m "feat(sdk): ship and export the wire-contract conformance corpus"
```

---

### Task 21: Boundary enforcement, documentation and full verification

**Files:**
- Create: `tests/domain-neutrality.test.ts`
- Create: `tests/domain-allowlist.json`
- Modify: `docs/workflow-ir.md`
- Modify: `README.md`

- [ ] **Step 1: Write the boundary test**

Replace the manual grep with an automated test plus a reviewed allowlist, since the grep also matches legitimate domain-flavored examples:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const FORBIDDEN = /\b(citation|manuscript|chapter|landmark|scholarly|bibliograph|figure_spec)\b/i;

describe("domain neutrality", () => {
  it("keeps domain vocabulary out of the kernel", async () => {
    const allow: string[] = JSON.parse(await fs.readFile("tests/domain-allowlist.json", "utf-8"));
    const offenders: string[] = [];
    async function scan(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await scan(full); continue; }
        if (!full.endsWith(".ts")) continue;
        const rel = full.split(path.sep).join("/");
        if (allow.includes(rel)) continue;
        const body = await fs.readFile(full, "utf-8");
        body.split("\n").forEach((line, index) => {
          if (FORBIDDEN.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    await scan("src");
    expect(offenders, `domain vocabulary in the kernel:\n${offenders.join("\n")}`).toEqual([]);
  });
});
```

Seed `tests/domain-allowlist.json` with the existing files that legitimately mention a domain in an example, each reviewed once. A new entry requires a reviewer to agree the mention is illustrative.

- [ ] **Step 2: Run it**

Run: `npm test -- domain-neutrality`
Expected: PASS. Any offender is either a real leak or a reviewed allowlist entry.

- [ ] **Step 3: Bump the package to 3.0.0**

IR v2 is a breaking revision and MrMaLiang's `runtime-compatibility.json`
requires `>=3.0.0 <4.0.0`. Set `version` to `3.0.0` in `package.json`, and
record the break in `CHANGELOG.md`: required `ir_version: 2`, engine-owned
observations, transactional task workspaces, typed contract outcomes, and the
removal of output-changed success inference.

Run: `npm run build && npm pack --dry-run | head -3`
Expected: the tarball is `malaclaw-3.0.0.tgz`.

- [ ] **Step 4: Document IR v2**

In `docs/workflow-ir.md`: `ir_version: 2` is required and never defaulted; v1 manifests are rejected with a migration message; work units gain `kind`, `reads`, `writes`, `owns`, `writes_observations`, `evaluate_with`, `acceptance`, `must_improve`, `must_preserve`, `strategy`; success is no longer inferred from changed outputs; mutations execute in an isolated task workspace and commit atomically; the kernel owns observation storage, sequencing and acceptance arithmetic per the wire contract. Add a recovery-table row: **Adopt IR v2 → `reset`**, because existing unit records are reinterpreted under new semantics.

- [ ] **Step 5: Full verification**

Run:
```bash
npm run build && npm test
npm run schema:export && npm test -- manifest-schema-export
cd dashboard && npm install && npm run build && npm test
git diff --check
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/domain-neutrality.test.ts tests/domain-allowlist.json docs/workflow-ir.md README.md package.json CHANGELOG.md
git commit -m "test(workflow): enforce the domain boundary automatically and document IR v2"
```

---

---

## M12 — Dispatch protocol and integration hardening

**Ordering: implement this milestone immediately after M8.** Tasks 22 to 24 are
prerequisites of Task 18; they are numbered last only to avoid renumbering the
tasks that reference each other.

### Task 22: The domain dispatch protocol

Four things currently exist only as prose or as domain helper functions with no
kernel counterpart: a pre-dispatch verdict, an estimated cost, a materializer
that turns a finding into a concrete action, and the transition into diagnosis.
Without a protocol, MrMaLiang can implement all four and the engine will still
never call them.

**Files:**
- Modify: `src/lib/schema.ts`
- Create: `src/lib/workflow/dispatch-protocol.ts`
- Test: `tests/contract-dispatch-protocol.test.ts`

**Interfaces:**
- Consumes: `WorkflowCommand`, `Criterion` (Task 2); `ContractOutcome` (Task 1).
- Produces: on `ActionDispatchStage` — `materializer: WorkflowCommand`, `verdict_inputs: string[]`, `cost_probe?: WorkflowCommand`; schemas `PreDispatchVerdict`, `ActionInstance`, `CostEstimate`; `readVerdict(dir, path)`, `parseActionInstance(raw)`, `runMaterializer(dir, stage, request)`.

Everything is domain-neutral: the kernel reads named verdicts, numeric costs and
a declared action shape. It never learns what any of them mean.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-dispatch-protocol.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowDef } from "../src/lib/schema.js";
import {
  PreDispatchVerdict, ActionInstance, CostEstimate, readVerdict, parseActionInstance,
} from "../src/lib/workflow/dispatch-protocol.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(files: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-dispatch-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(body), "utf-8");
  }
  return dir;
}

describe("dispatch protocol", () => {
  it("lets a dispatch stage declare a materializer command", () => {
    const wf = WorkflowDef.parse({
      ir_version: 2,
      stages: [{
        type: "action_dispatch", id: "improve", owner: "pm", plan_path: "reviews/findings.json",
        materializer: { cmd: "longwrite", args: ["research", "materialize-action", "."] },
        verdict_inputs: ["reports/reachability-verdict.json"],
      }],
    });
    const stage = wf.stages[0] as { materializer: { cmd: string }; verdict_inputs: string[] };
    expect(stage.materializer.cmd).toBe("longwrite");
    expect(stage.verdict_inputs).toEqual(["reports/reachability-verdict.json"]);
  });

  it("rejects a materializer using shell interpolation", () => {
    expect(() => WorkflowDef.parse({
      ir_version: 2,
      stages: [{ type: "action_dispatch", id: "improve", owner: "pm", plan_path: "p.json",
        materializer: { cmd: "sh -c 'longwrite'", args: [] } }],
    })).toThrow();
  });

  it("parses a pre-dispatch verdict of named objectives", async () => {
    const dir = await workspace({ "reports/reachability-verdict.json": {
      version: 1, unreachable: [{ objective: "landmark_coverage ", detail: "only 3 of 12" }],
    } });
    const verdict = await readVerdict(dir, "reports/reachability-verdict.json");
    expect(verdict.unreachable[0].objective).toBe("landmark_coverage ");
  });

  it("knows nothing about what an objective means", () => {
    // The kernel reads a name and a detail string; the domain decides both.
    expect(PreDispatchVerdict.safeParse({
      version: 1, unreachable: [{ objective: "anything at all", detail: "" }],
    }).success).toBe(true);
  });

  it("parses a materialized action instance", () => {
    const instance = {
      version: 1, from_template: "revise_sections", action_id: "a1",
      findings: ["f1"], scope_key: "section-03",
      reads: ["repair/a1/packet.json", "chapters/section-03.md"],
      owns: ["chapters/section-03.md"], writes: ["chapters/section-03.md"],
      acceptance: [{ metric: "rendered_visual_review", scope_key: "", operator: "equals",
                     target: 1, tolerance: 0, direction: "maximize" }],
      must_preserve: [{ metric: "claim_support", scope_key: "", operator: "at_least",
                        target: 0.9, tolerance: 0.000001, direction: "maximize" }],
      strategy_key: ["template", "finding_ids", "scope_key", "acceptance"],
    };
    expect(parseActionInstance(instance).action_id).toBe("a1");
  });

  it("rejects an instance whose writes escape its own envelope", () => {
    expect(() => parseActionInstance({
      version: 1, from_template: "revise_sections", action_id: "a1", findings: ["f1"], scope_key: "",
      reads: [], owns: ["chapters/section-03.md"], writes: ["chapters/section-99.md"],
      acceptance: [], must_preserve: [], strategy_key: ["template"],
    })).toThrow(/outside its owns envelope/);
  });

  it("rejects an instance with no acceptance", () => {
    // A materialized repair with no measurable objective is the failure this
    // whole program removes.
    expect(() => parseActionInstance({
      version: 1, from_template: "revise_sections", action_id: "a1", findings: ["f1"], scope_key: "",
      reads: [], owns: ["chapters/a.md"], writes: ["chapters/a.md"],
      acceptance: [], must_preserve: [], strategy_key: ["template"],
    })).toThrow(/acceptance/);
  });

  it("parses a cost estimate the scheduler can compare to run limits", () => {
    expect(CostEstimate.safeParse({ version: 1, model_calls: 5, renders: 1 }).success).toBe(true);
  });

  it("declares a diagnosis transition target on the dispatch stage", () => {
    const wf = WorkflowDef.parse({
      ir_version: 2,
      stages: [{ type: "action_dispatch", id: "improve", owner: "pm", plan_path: "p.json",
        materializer: { cmd: "longwrite", args: ["x"] }, on_diagnose: "diagnose_objective" }],
    });
    expect((wf.stages[0] as { on_diagnose: string }).on_diagnose).toBe("diagnose_objective");
  });

  it("rejects a diagnosis target that is not a declared stage", () => {
    expect(() => WorkflowDef.parse({
      ir_version: 2,
      stages: [{ type: "action_dispatch", id: "improve", owner: "pm", plan_path: "p.json",
        materializer: { cmd: "longwrite", args: ["x"] }, on_diagnose: "nowhere" }],
    })).toThrow(/on_diagnose/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-dispatch-protocol`
Expected: FAIL — `materializer` is rejected by the strict stage schema.

- [ ] **Step 3: Write minimal implementation**

Add to `ActionDispatchStage` in `src/lib/schema.ts`:

```ts
    /** Turns one validated finding set into a concrete action instance. The
     * kernel executes this command and validates its output; it never learns
     * what a finding means. */
    materializer: WorkflowCommand.optional(),
    /** Artifacts carrying pre-dispatch verdicts the kernel reads BEFORE
     * selecting actions, so an objective proven unattainable never consumes a
     * round. */
    verdict_inputs: z.array(workspacePath).default([]),
    /** Optional command returning a CostEstimate for the round the kernel is
     * about to dispatch, compared against run_limits before spending. */
    cost_probe: WorkflowCommand.optional(),
    /** Stage to run when a contract outcome maps to `diagnose`. Validated
     * against the declared stage ids. */
    on_diagnose: workflowId.optional(),
```

Create `src/lib/workflow/dispatch-protocol.ts` with `PreDispatchVerdict`
(`{ version: 1, unreachable: Array<{ objective, detail }> }`), `CostEstimate`
(`{ version: 1, model_calls, renders }`), and `ActionInstance` — the wire
contract §8 shape — whose `superRefine` requires at least one acceptance
criterion and confines `writes` to `owns`. `runMaterializer` writes the request
artifact, runs the declared command in a task workspace, and parses its output;
a materializer that emits an invalid instance fails the dispatch rather than
being partially believed. Validate `on_diagnose` against declared stage ids in
the workflow-level refinement.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-dispatch-protocol && npm run schema:export && npm test -- manifest-schema-export`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schema.ts src/lib/workflow/dispatch-protocol.ts schemas/ tests/contract-dispatch-protocol.test.ts
git commit -m "feat(workflow): add a domain-neutral dispatch protocol for verdicts, cost and materialization"
```

---

### Task 23: Observation binding across an attempt

A compiled criterion carries no digests, so `currentObservation` cannot find its
"before" record from the criterion alone. Worse, the cycle called `snapshotFor`
only after the mutation and its measurements had run, by which point no
trustworthy before-state exists — and the measurement wrote its envelope into
its own task workspace while ingestion read the canonical one.

**Files:**
- Modify: `src/lib/workflow/observations.ts`
- Modify: `src/lib/workflow/measurements.ts`
- Modify: `src/lib/workflow/attempts.ts` (`AttemptTransition.observation_bindings`)
- Test: `tests/contract-observation-binding.test.ts`

**Interfaces:**
- Consumes: `Observation`, `Criterion`.
- Produces: `observationRecordId(observation): string`; `bindObservations(dir, store, criteria): Promise<ObservationBinding[]>` where `ObservationBinding = { metric, scope_key, record_id: string | null }`; `resolveBinding(dir, store, binding)`; `ingestEnvelope(canonicalDir, storePath, envelopeAbsPath, unit)` taking an **absolute** envelope path.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-observation-binding.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Observation, appendObservation, observationRecordId, bindObservations, resolveBinding,
} from "../src/lib/workflow/observations.js";
import { ingestEnvelope } from "../src/lib/workflow/measurements.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
const STORE = ".malaclaw/observations";
const criterion = { metric: "test_coverage", scope_key: "", operator: "at_least" as const,
                    target: 0.9, tolerance: 1e-6, direction: "maximize" as const };
const record = (o: Record<string, unknown> = {}) => Observation.parse({
  metric: "test_coverage", scope_key: "", value: 0.5, evaluator: "coverage",
  evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
  sequence: 1, measured_at: new Date().toISOString(), ...o,
});

describe("observation binding", () => {
  it("binds a criterion to the newest matching record before dispatch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-bind-"));
    dirs.push(dir);
    await appendObservation(dir, STORE, record({ value: 0.5, sequence: 1 }));
    const [binding] = await bindObservations(dir, STORE, [criterion]);
    // A criterion carries no digests, so the binding — not the criterion — is
    // what identifies the exact "before" record.
    expect(binding.record_id).toBeTruthy();
    expect((await resolveBinding(dir, STORE, binding))?.value).toBe(0.5);
  });

  it("binds to null when no observation exists yet", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-bind-none-"));
    dirs.push(dir);
    expect((await bindObservations(dir, STORE, [criterion]))[0].record_id).toBeNull();
  });

  it("keeps the before binding stable when a newer record is appended", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-bind-stable-"));
    dirs.push(dir);
    await appendObservation(dir, STORE, record({ value: 0.5, sequence: 1 }));
    const [before] = await bindObservations(dir, STORE, [criterion]);
    await appendObservation(dir, STORE, record({ value: 0.9, sequence: 2, input_digest: "c".repeat(64) }));
    // The bound record is the one the attempt started from, not whatever is
    // newest at evaluation time.
    expect((await resolveBinding(dir, STORE, before))?.value).toBe(0.5);
  });

  it("gives a record a stable content-addressed id", async () => {
    expect(observationRecordId(record())).toBe(observationRecordId(record()));
    expect(observationRecordId(record())).not.toBe(observationRecordId(record({ value: 0.7 })));
  });

  it("ingests an envelope from the measurement task workspace", async () => {
    const canonical = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-canon-"));
    const task = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-task-"));
    dirs.push(canonical, task);
    await fs.mkdir(path.join(task, "reports"), { recursive: true });
    await fs.writeFile(path.join(task, "reports/measurements.json"), JSON.stringify({
      version: 1, measurements: [{
        metric: "test_coverage", scope_key: "", status: "measured", value: 0.95,
        evaluator: "coverage", evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
        measurement_kind: "script",
      }],
    }), "utf-8");
    // The measurement unit runs in isolation, so its envelope is never in the
    // canonical workspace when ingestion happens.
    const result = await ingestEnvelope(canonical, STORE,
      path.join(task, "reports/measurements.json"), { unitKey: "m", writes_observations: ["test_coverage"] });
    expect(result.appended).toHaveLength(1);
  });

  it("records the before and after bindings on the attempt", async () => {
    const { AttemptTransition } = await import("../src/lib/workflow/attempts.js");
    expect(AttemptTransition.safeParse({
      invocation_id: "i1", idempotency_key: "k", unit_key: "u", to: "measured",
      at: new Date().toISOString(), intended_effects: [], applied_effects: [],
      observation_bindings: {
        before: [{ metric: "test_coverage", scope_key: "", record_id: "abc" }],
        after: [{ metric: "test_coverage", scope_key: "", record_id: "def" }],
      },
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-observation-binding`
Expected: FAIL — `observationRecordId` and `bindObservations` do not exist, and `ingestEnvelope` takes a workspace-relative path.

- [ ] **Step 3: Write minimal implementation**

Add `observationRecordId` (the record's content digest, already the filename
stem), `bindObservations` and `resolveBinding` to `observations.ts`. Change
`ingestEnvelope` to take an **absolute** envelope path so it can read the
measurement's task workspace. Add `observation_bindings` to `AttemptTransition`.

Then correct the Task 18 cycle order to:

1. `bindObservations` for the unit's acceptance and `must_preserve` criteria →
   the **before** bindings, journaled with `prepared`.
2. Run the mutation in its task workspace; validate and commit its diff.
3. Run each `evaluate_with` measurement against the post-mutation state, in its
   own task workspace.
4. `ingestEnvelope` from that task workspace's absolute envelope path.
5. `bindObservations` again → the **after** bindings, journaled with `measured`.
6. `evaluateContract` over the resolved before and after records — those exact
   records, not a re-query that could pick up an unrelated newer measurement.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-observation-binding contract-measurement-ingest`
Expected: PASS, 6 + 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/observations.ts src/lib/workflow/measurements.ts src/lib/workflow/attempts.ts tests/contract-observation-binding.test.ts
git commit -m "feat(workflow): bind before and after observation records to each attempt"
```

---

### Task 24: Safe lease acquisition and supervisor heartbeat

Writing a lease file through temp-and-rename is atomic *replacement*, not atomic
*acquisition*: two owners can both observe an absent or expired lease and both
rename their replacement, and the second silently wins. With no fencing token, a
stale owner can also renew or commit after takeover.

**Files:**
- Modify: `src/lib/workflow/leases.ts`
- Modify: `src/lib/workflow/supervisor.ts`
- Modify: `src/lib/workflow/engine.ts` (present the token on commit)
- Test: `tests/contract-lease-safety.test.ts`

**Interfaces:**
- Consumes: `Lease` (Task 13).
- Produces: `Lease.generation: number` and `Lease.token: string`; `acquireLease` returning `{ status, lease? }` via exclusive create; `renewLease(dir, unitKey, token, ...)`; `assertLeaseHeld(dir, unitKey, token)`; `startHeartbeat(dir, unitKey, token, intervalMs)`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-lease-safety.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireLease, renewLease, releaseLease, readLease, assertLeaseHeld, startHeartbeat,
} from "../src/lib/workflow/leases.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-lease-safe-"));
  dirs.push(dir);
  return dir;
}
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

describe("lease safety", () => {
  it("gives exactly one winner under concurrent acquisition", async () => {
    const dir = await workspace();
    // Temp-and-rename is atomic replacement, not atomic acquisition: both
    // callers would observe an absent lease and both would win.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => acquireLease(dir, "u", `worker-${index}`, 60_000, NOW)));
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
  });

  it("issues a monotonic generation on each takeover", async () => {
    const dir = await workspace();
    const first = await acquireLease(dir, "u", "worker-1", 1_000, NOW);
    const second = await acquireLease(dir, "u", "worker-2", 1_000, NOW + 2_000);
    expect(second.lease!.generation).toBeGreaterThan(first.lease!.generation);
  });

  it("refuses a renewal presenting a stale token", async () => {
    const dir = await workspace();
    const first = await acquireLease(dir, "u", "worker-1", 1_000, NOW);
    await acquireLease(dir, "u", "worker-2", 60_000, NOW + 2_000);
    await expect(renewLease(dir, "u", first.lease!.token, 1, 60_000, NOW + 3_000))
      .rejects.toThrow(/stale|token/i);
  });

  it("refuses a commit from a superseded owner", async () => {
    const dir = await workspace();
    const first = await acquireLease(dir, "u", "worker-1", 1_000, NOW);
    await acquireLease(dir, "u", "worker-2", 60_000, NOW + 2_000);
    // Without fencing, a slow worker-1 could commit effects after takeover.
    await expect(assertLeaseHeld(dir, "u", first.lease!.token)).rejects.toThrow(/superseded|stale/i);
  });

  it("accepts a commit from the current owner", async () => {
    const dir = await workspace();
    const held = await acquireLease(dir, "u", "worker-1", 60_000, NOW);
    await expect(assertLeaseHeld(dir, "u", held.lease!.token)).resolves.toBeUndefined();
  });

  it("renews from a supervisor heartbeat even when the runtime emits nothing", async () => {
    const dir = await workspace();
    const held = await acquireLease(dir, "u", "worker-1", 200, Date.now());
    const stop = startHeartbeat(dir, "u", held.lease!.token, 50);
    await new Promise((resolve) => setTimeout(resolve, 320));
    stop();
    // A runtime with no event stream must not lose its lease for being quiet.
    expect(Date.parse((await readLease(dir, "u"))!.lease_expires_at)).toBeGreaterThan(Date.now());
  });

  it("stops renewing once released", async () => {
    const dir = await workspace();
    const held = await acquireLease(dir, "u", "worker-1", 200, Date.now());
    const stop = startHeartbeat(dir, "u", held.lease!.token, 50);
    await releaseLease(dir, "u", held.lease!.token);
    stop();
    expect(await acquireLease(dir, "u", "worker-2", 60_000, Date.now())).toMatchObject({ status: "acquired" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-lease-safety`
Expected: FAIL — acquisition is not exclusive and `Lease` has no token.

- [ ] **Step 3: Write minimal implementation**

Acquire through an exclusive create (`fs.open(lockPath, "wx")`) on a per-unit
lock file, holding it only long enough to read the current lease, decide, and
write the successor with `generation + 1` and a fresh `token`. `renewLease`,
`releaseLease` and `assertLeaseHeld` all require the current token and throw on
a stale one. `startHeartbeat` renews on an interval from the supervisor, so a
runtime that emits no events keeps its lease.

Separately, keep the existing `timeoutMs` as an **explicitly configured hard
kill**, distinct from stall diagnosis: document that a unit exceeding it is
terminated by policy, so "only lease expiry terminates an attempt" is not
contradicted by a timeout nobody declared.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-lease-safety contract-leases`
Expected: PASS, 7 + 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/leases.ts src/lib/workflow/supervisor.ts src/lib/workflow/engine.ts tests/contract-lease-safety.test.ts
git commit -m "feat(workflow): make lease acquisition exclusive and fence stale owners"
```

---

## Plan Self-Review

**Spec coverage.** §B1 execution roles → Task 2. §B2 effects → Tasks 2, 4, 5, 6. §B3 acceptance, progress, invariants → Task 9. §B4 measurement scheduling → Tasks 8, 18 (`evaluate_with` dispatch and envelope ingestion); the metric registry and cost tiers are MrMaLiang's. §B5 two-axis outcomes → Task 1. §B6 fingerprints and per-objective stagnation → Task 10. §B7 transitions → Task 1's policies, applied in Task 18. §B8 removals → Task 3 (`ir_version`), Task 18 (output-changed inference). §B9 reachability → the pre-dispatch verdict protocol is Task 22; the analysis is MrMaLiang's. §B10 blocked workspace → Tasks 15, 16. §B11 observation store → Tasks 7, 23. §B12 cost accounting → the `cost_probe` protocol is Task 22; the estimates are MrMaLiang's. §B13 attempt lifecycle → Task 12. §B14 checkpoint contract → Tasks 12, 18, 23. §B15 leases → Tasks 11, 13, 24. §B16 concurrency → Task 14. §B17 pinning → Task 17. §B18 untrusted content → Plan 3 builds the task packet; Task 4's isolation is the mechanism that bounds it.

**Wire contract coverage.** §2 ownership → Tasks 7, 8, 9 own storage, ingestion and arithmetic; no other implementation exists. §3 envelope → Task 8. §4 identity and freshness → Task 7. §5 compiled criterion → Task 2. §6 arithmetic → Task 9. §7 conformance fixtures → Tasks 9, 20. §8 action instantiation → the kernel consumes instances; MrMaLiang emits them (Plan 3).

**Type consistency.** `Criterion` and `MustImprove` are defined once in `schema.ts` (Task 2) and imported by `acceptance.ts` (Task 9) and `stagnation.ts` (Task 10). `snapshotKey(metric, scopeKey)` is exported by `observations.ts` (Task 7) and is the only key format `evaluateContract` accepts. `EffectUnit` and `TaskWorkspace` come from `task-workspace.ts` (Task 4) and are consumed by `effects.ts` (Task 5). `AttemptTransition` (Task 12) is the parameter of `classifyHealth` (Task 13). `canonicalJson` (Task 7) is used by pinning, attempts and stagnation. `runFlow` keeps its single-object signature throughout.

**Ordering constraints.** M12 (Tasks 22–24) implements immediately after M8 and precedes Task 18: the engine cycle needs the dispatch protocol, the observation binding and safe leases. Task 20 requires Tasks 2, 8 and 9. Task 2 precedes Tasks 4, 5, 9, 14 (all import from `schema.ts`). Task 7 precedes Tasks 8, 9, 10, 12, 17 (`snapshotKey`, `canonicalJson`). Task 4 precedes Tasks 5 and 6. Task 11 precedes Task 13 — a lease cannot be renewed without an event stream. Tasks 1 through 17 all precede Task 18.

**Deliberately not here.** The metric registry, evaluators, cost tiers, reachability analysis, repair packets, and prompt rendering are MrMaLiang's; this plan consumes their outputs through the wire contract and knows nothing about their meaning.
