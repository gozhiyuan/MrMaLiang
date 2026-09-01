# Contract Core, Plan 2: MalaClaw Contract IR v2 Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: BLOCKED — do not execute.** A review found compile-time and
> semantic defects in this plan. It must be amended against
> [the Observation and Criterion Wire Contract](../specs/2026-09-01-observation-and-criterion-wire-contract.md)
> before any task is started. The required amendments are listed at the end of
> this document under "Pending Amendments".


**Goal:** Replace "a unit succeeded because its declared outputs changed" with a contract kernel that enforces effects, measures acceptance against an observation store, protects invariants, detects per-objective stagnation, and returns typed outcomes — without learning a single domain concept.

**Architecture:** IR v2 is a breaking revision of `src/lib/schema.ts`. Work units gain execution roles (`mutation` / `measurement`), effect declarations (`reads` / `writes` / `owns`), acceptance with gap-relative progress, protected invariants, and strategy keys. The engine gains a before/after observation snapshot around each unit, a write-envelope conflict graph, an attempt journal with leases, and run pinning. Every test in this plan uses code-repair, document-score, and data-validity fixtures — if a test mentions a citation, figure, or manuscript, it is in the wrong repository.

**Tech Stack:** TypeScript (ESM, Node 22+), Zod 3, Vitest 4 (`globals: true`, but tests import explicitly to match the existing suite).

**Spec:** `../../../MrMaLiang/docs/superpowers/specs/2026-08-31-contract-enforcement-core-design.md` — Part B (§B1–B18), plus §B5's two-axis outcome model. Read Part B before starting; Part A is Plan 1's and lives in MrMaLiang.

## Global Constraints

- Node.js 22 or newer. ESM throughout; **relative imports carry the `.js` extension** in `.ts` files.
- **MalaClaw learns no domain semantics.** It sees named numeric observations, declared file effects, and typed outcomes. A PR adding the word "citation", "chapter", "figure", or "landmark" to `src/` is wrong by construction.
- **IR v2 is breaking.** Do not add optional compatibility fields around v1 behavior. Bump `ir_version` to 2, reject v1 manifests with a specific message, and reinitialize test workspaces. There are no in-flight runs worth preserving.
- `src/lib/schema.ts` is the canonical Zod definition. `schemas/*.json` are generated — run `npm run schema:export` after any schema change or `tests/manifest-schema-export.test.ts` fails.
- Never order or compare observations by wall-clock time. Freshness resolves by digest and monotonic sequence.
- A wall-clock timeout never terminates an attempt. Only lease expiry does.
- Structured commands only (`cmd` + `args`). No shell interpolation.
- Tests: `npm test`. Build before CLI behavior tests — the CLI runs from `dist/`.
- Preserve the dirty worktree. Only touch files named in a task.

---

### Task 1: Two-axis outcome model

**Files:**
- Create: `src/lib/workflow/outcomes.ts`
- Test: `tests/contract-outcomes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ExecutionOutcome` and `ContractOutcome` Zod enums and types; `EXECUTION_POLICY: Record<ExecutionOutcome, ExecutionAction>`; `CONTRACT_POLICY: Record<ContractOutcome, ContractAction>`; types `ExecutionAction = "evaluate_contract" | "retry_unit" | "reconcile_then_retry" | "pause_and_resume_from_checkpoint" | "pause"`; `ContractAction = "continue" | "retry" | "defer_to_round" | "diagnose" | "change_strategy" | "pause" | "block" | "reject" | "retry_measurement_then_block"`; `executionAction(o)`, `contractAction(o)`, `blocksWorkspace(o: ContractOutcome): boolean`.

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
    // A unit can execute perfectly and still fail its quality contract.
    expect(executionAction("completed")).toBe("evaluate_contract");
    expect(contractAction("unmet")).toBe("diagnose");
  });

  it("gives every contract outcome exactly one policy", () => {
    for (const outcome of ContractOutcome.options) {
      expect(CONTRACT_POLICY[outcome], `no policy for ${outcome}`).toBeDefined();
    }
  });

  it("gives every execution outcome exactly one policy", () => {
    for (const outcome of ExecutionOutcome.options) {
      expect(EXECUTION_POLICY[outcome], `no policy for ${outcome}`).toBeDefined();
    }
  });

  it("treats a unit with no quality objective as not_applicable", () => {
    expect(contractAction("not_applicable")).toBe("continue");
  });

  it("resumes a quota interruption instead of counting it as a failed strategy", () => {
    expect(executionAction("quota_exhausted")).toBe("pause_and_resume_from_checkpoint");
  });

  it("blocks the workspace for regressions and effect violations", () => {
    expect(blocksWorkspace("regressed")).toBe(true);
    expect(blocksWorkspace("partially_improved_with_regression")).toBe(true);
    expect(blocksWorkspace("undeclared_write")).toBe(true);
    expect(blocksWorkspace("undeclared_read")).toBe(true);
    expect(blocksWorkspace("requires_reconciliation")).toBe(true);
  });

  it("does not block for a merely unmet objective", () => {
    expect(blocksWorkspace("unmet")).toBe(false);
    expect(blocksWorkspace("improved")).toBe(false);
  });

  it("retries a failed measurement before blocking", () => {
    expect(contractAction("measurement_failed")).toBe("retry_measurement_then_block");
  });

  it("distinguishes exhausted strategies from proven unreachability", () => {
    expect(ContractOutcome.options).toContain("strategy_exhausted");
    expect(ContractOutcome.options).toContain("unreachable");
    expect(contractAction("strategy_exhausted")).toBe("pause");
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

/** Was the contract satisfied? `not_applicable` is the normal result for a
 * unit with no quality objective. */
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
  // An execution interruption, not a failed repair strategy: it must never
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
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/outcomes.ts tests/contract-outcomes.test.ts
git commit -m "feat(workflow): separate execution outcomes from contract outcomes"
```

---

### Task 2: Effect declarations in IR v2

**Files:**
- Modify: `src/lib/schema.ts` (add to `workUnitFields`; bump `ir_version` default to 2)
- Test: `tests/contract-effects-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: on every work unit — `kind: "mutation" | "measurement" | "plain"` (default `"plain"`), `reads: string[]`, `owns: string[]`, `writes_observations: string[]`, `evaluate_with: string[]`. `WorkflowDef.ir_version` defaults to `2`. `WorkflowDef.observation_store: string` defaults to `".malaclaw/observations"`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-effects-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WorkflowDef } from "../src/lib/schema.js";

describe("IR v2 effect declarations", () => {
  it("defaults to ir_version 2", () => {
    const wf = WorkflowDef.parse({ stages: [{ id: "a", owner: "x", outputs: ["a.md"] }] });
    expect(wf.ir_version).toBe(2);
  });

  it("accepts a mutation unit with an ownership envelope", () => {
    const wf = WorkflowDef.parse({
      stages: [{
        id: "repair", owner: "eng", kind: "mutation",
        reads: ["src/**"], writes: ["src/a.ts"], owns: ["src/**"],
        outputs: ["src/a.ts"], evaluate_with: ["measure"],
      }],
    });
    const stage = wf.stages[0] as { kind: string; owns: string[]; evaluate_with: string[] };
    expect(stage.kind).toBe("mutation");
    expect(stage.owns).toEqual(["src/**"]);
    expect(stage.evaluate_with).toEqual(["measure"]);
  });

  it("accepts a measurement unit declaring the observations it writes", () => {
    const wf = WorkflowDef.parse({
      stages: [{
        id: "measure", owner: "ci", kind: "measurement",
        reads: ["src/**"], writes_observations: ["test_coverage"],
      }],
    });
    const stage = wf.stages[0] as { writes_observations: string[] };
    expect(stage.writes_observations).toEqual(["test_coverage"]);
  });

  it("rejects a mutation unit that writes observations grading itself", () => {
    expect(() => WorkflowDef.parse({
      stages: [{
        id: "repair", owner: "eng", kind: "mutation",
        writes: ["src/a.ts"], owns: ["src/**"], writes_observations: ["test_coverage"],
      }],
    })).toThrow(/mutation unit may not write observations/i);
  });

  it("rejects a measurement unit that mutates files", () => {
    expect(() => WorkflowDef.parse({
      stages: [{
        id: "measure", owner: "ci", kind: "measurement",
        writes: ["src/a.ts"], owns: ["src/**"], writes_observations: ["test_coverage"],
      }],
    })).toThrow(/measurement unit may not declare writes/i);
  });

  it("requires writes to fall inside the ownership envelope", () => {
    expect(() => WorkflowDef.parse({
      stages: [{
        id: "repair", owner: "eng", kind: "mutation",
        writes: ["docs/a.md"], owns: ["src/**"], outputs: ["docs/a.md"],
      }],
    })).toThrow(/outside its owns envelope/i);
  });

  it("declares the observation store path rather than hardcoding one", () => {
    const wf = WorkflowDef.parse({ stages: [{ id: "a", owner: "x" }] });
    expect(wf.observation_store).toBe(".malaclaw/observations");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-effects-schema`
Expected: FAIL — `ir_version` is 1 and `kind` is rejected by the strict object.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/schema.ts`, add to `workUnitFields`:

```ts
  /** Execution role. `plain` is a unit with no contract at all — the historical
   * behavior. Roles are what let the kernel forbid a mutation from writing its
   * own grade without knowing what any observation means. */
  kind: z.enum(["plain", "mutation", "measurement"]).default("plain"),
  /** Declared context and dependency set. Contributes to the input digest. */
  reads: z.array(workspacePath).default([]),
  /** Allowed mutation envelope. A superset of `writes`; permission, not
   * obligation, so an owned-but-unchanged path is legal. */
  owns: z.array(workspacePath).default([]),
  /** Measurement units only: which named observations this unit produces. */
  writes_observations: z.array(z.string().min(1)).default([]),
  /** Mutation units only: which measurement unit(s) grade this one. */
  evaluate_with: z.array(workflowId).default([]),
```

Add a `superRefine` to both `StandardStage` and `WorkflowAction` (after `.strict()`, before `.transform(normalizeOutputs)`):

```ts
function refineEffects(unit: {
  kind: string; writes?: string[]; owns: string[]; writes_observations: string[]; outputs: unknown[];
}, ctx: z.RefinementCtx): void {
  if (unit.kind === "mutation" && unit.writes_observations.length > 0) {
    ctx.addIssue({ code: "custom", path: ["writes_observations"],
      message: "a mutation unit may not write observations used to grade itself; declare a separate measurement unit" });
  }
  if (unit.kind === "measurement" && unit.owns.length > 0) {
    ctx.addIssue({ code: "custom", path: ["owns"],
      message: "a measurement unit may not declare writes or an ownership envelope over what it measures" });
  }
  const declared = unit.outputs.map((o) => (typeof o === "string" ? o : (o as { path: string }).path));
  for (const target of declared) {
    if (unit.owns.length > 0 && !unit.owns.some((pattern) => matchesEnvelope(pattern, target))) {
      ctx.addIssue({ code: "custom", path: ["outputs"],
        message: `declared output ${target} falls outside its owns envelope` });
    }
  }
}

/** Glob support is deliberately minimal: a trailing `/**` prefix match, or an
 * exact path. Anything richer invites disagreement about what an envelope
 * means, and the envelope is a safety boundary. */
export function matchesEnvelope(pattern: string, filePath: string): boolean {
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -2));
  return pattern === filePath;
}
```

Change `ir_version: z.number().int().min(1).default(1)` to `.default(2)`, and add to `WorkflowDef`:

```ts
    /** Where observations live. Previously hardcoded to reports/metrics.json in
     * stop-condition.ts, which was a domain assumption inside the kernel. */
    observation_store: workspacePath.default(".malaclaw/observations"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-effects-schema`
Expected: PASS, 7 tests.

- [ ] **Step 5: Regenerate the exported JSON Schema**

Run: `npm run schema:export && npm test -- manifest-schema-export`
Expected: PASS. The exported schema is the cross-language SDK contract; a schema change without regeneration is a failing test, not a silent drift.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schema.ts schemas/ tests/contract-effects-schema.test.ts
git commit -m "feat!: add execution roles and effect declarations to IR v2"
```

---

### Task 3: Reject IR v1 manifests explicitly

**Files:**
- Modify: `src/lib/workflow/validate.ts`
- Test: `tests/contract-ir-version.test.ts`

**Interfaces:**
- Consumes: `WorkflowDef` (Task 2).
- Produces: `assertSupportedIrVersion(workflow: WorkflowDef): void` throwing `IrVersionError` with a migration message.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-ir-version.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WorkflowDef } from "../src/lib/schema.js";
import { assertSupportedIrVersion, IrVersionError } from "../src/lib/workflow/validate.js";

describe("IR version enforcement", () => {
  it("accepts a v2 manifest", () => {
    const wf = WorkflowDef.parse({ ir_version: 2, stages: [{ id: "a", owner: "x" }] });
    expect(() => assertSupportedIrVersion(wf)).not.toThrow();
  });

  it("rejects a v1 manifest with a migration message rather than a generic error", () => {
    const wf = WorkflowDef.parse({ ir_version: 1, stages: [{ id: "a", owner: "x" }] });
    expect(() => assertSupportedIrVersion(wf)).toThrow(IrVersionError);
    try {
      assertSupportedIrVersion(wf);
    } catch (error) {
      expect((error as Error).message).toMatch(/ir_version 1 is no longer supported/);
      expect((error as Error).message).toMatch(/recompile/);
    }
  });

  it("rejects a future version rather than guessing", () => {
    const wf = WorkflowDef.parse({ ir_version: 3, stages: [{ id: "a", owner: "x" }] });
    expect(() => assertSupportedIrVersion(wf)).toThrow(IrVersionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-ir-version`
Expected: FAIL — `assertSupportedIrVersion` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/workflow/validate.ts`:

```ts
import type { WorkflowDef } from "../schema.js";

export const SUPPORTED_IR_VERSION = 2;

export class IrVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `ir_version ${found} is no longer supported; this engine executes ir_version ${SUPPORTED_IR_VERSION}. ` +
      `Recompile the workflow with a current compiler and reinitialize the workspace with \`malaclaw flow reset\`. ` +
      `Existing artifacts are preserved; only flow state is reinitialized.`,
    );
    this.name = "IrVersionError";
  }
}

/** Fails closed on both sides. A v1 manifest executed under v2 semantics would
 * reinterpret every completed unit record, and guessing at a future version is
 * worse than refusing. */
export function assertSupportedIrVersion(workflow: WorkflowDef): void {
  if (workflow.ir_version !== SUPPORTED_IR_VERSION) throw new IrVersionError(workflow.ir_version);
}
```

Call it at the top of the existing workflow validation entry point.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-ir-version`
Expected: PASS, 3 tests.

- [ ] **Step 5: Update fixtures that still declare v1**

Run: `npm test`
Expected: some existing tests fail because their fixtures are v1. Add `ir_version: 2` to each fixture under `tests/fixtures/`. Do not weaken `assertSupportedIrVersion` to make them pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/validate.ts tests/contract-ir-version.test.ts tests/fixtures/
git commit -m "feat!: reject ir_version 1 manifests with an explicit migration message"
```

---

### Task 4: Observation store and snapshots

**Files:**
- Create: `src/lib/workflow/observations.ts`
- Test: `tests/contract-observations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Observation` Zod schema (`metric`, `value`, `target?`, `operator?`, `evaluator`, `evaluator_digest`, `input_digest`, `sequence`, `measured_at`); `appendObservation(dir, storePath, observation)`; `currentValues(dir, storePath): Promise<Map<string, Observation>>`; `snapshotValues(dir, storePath): Promise<Record<string, number>>`; `nextSequence(dir, storePath): Promise<number>`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-observations.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Observation, appendObservation, currentValues, snapshotValues, nextSequence,
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
function record(overrides: Record<string, unknown> = {}) {
  return Observation.parse({
    metric: "test_coverage", value: 0.62, evaluator: "coverage",
    evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
    sequence: 1, measured_at: new Date().toISOString(), ...overrides,
  });
}

describe("observation store", () => {
  it("writes an immutable content-addressed record", async () => {
    const dir = await workspace();
    const written = await appendObservation(dir, STORE, record());
    expect(written).toContain(path.join(STORE, "test_coverage", "b".repeat(64), "coverage"));
  });

  it("resolves the current value by sequence, never by clock", async () => {
    const dir = await workspace();
    await appendObservation(dir, STORE, record({ value: 0.9, sequence: 9 }));
    await appendObservation(dir, STORE, record({
      value: 0.1, sequence: 4, input_digest: "c".repeat(64),
      measured_at: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    expect((await currentValues(dir, STORE)).get("test_coverage")?.value).toBe(0.9);
  });

  it("produces a flat numeric snapshot for before/after comparison", async () => {
    const dir = await workspace();
    await appendObservation(dir, STORE, record({ value: 0.62 }));
    await appendObservation(dir, STORE, record({
      metric: "row_validity", value: 1, evaluator: "rows", input_digest: "d".repeat(64),
    }));
    expect(await snapshotValues(dir, STORE)).toEqual({ test_coverage: 0.62, row_validity: 1 });
  });

  it("returns an empty snapshot for a workspace with no observations", async () => {
    const dir = await workspace();
    expect(await snapshotValues(dir, STORE)).toEqual({});
  });

  it("hands out monotonically increasing sequences", async () => {
    const dir = await workspace();
    expect(await nextSequence(dir, STORE)).toBe(1);
    await appendObservation(dir, STORE, record({ sequence: 7 }));
    expect(await nextSequence(dir, STORE)).toBe(8);
  });

  it("rejects an observation without a sequence", () => {
    expect(() => Observation.parse({
      metric: "m", value: 1, evaluator: "e",
      evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
      measured_at: new Date().toISOString(),
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-observations`
Expected: FAIL — cannot resolve `observations.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/observations.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const Observation = z.object({
  metric: z.string().min(1),
  value: z.number().finite(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  evaluator: z.string().min(1),
  evaluator_digest: z.string().regex(/^[0-9a-f]{64}$/),
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Monotonic engine sequence. Under foreach, clock order and causal order
   * diverge, so freshness must never resolve on `measured_at`. */
  sequence: z.number().int().nonnegative(),
  measured_at: z.string().datetime(),
}).strict();
export type Observation = z.infer<typeof Observation>;

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else if (entry.name.endsWith(".json")) found.push(full);
  }
  return found.sort();
}

/** Immutable, content-addressed, atomically renamed: concurrent fan-out writers
 * never clobber one another because no record is ever rewritten. */
export async function appendObservation(
  workspaceDir: string, storePath: string, observation: Observation,
): Promise<string> {
  const parsed = Observation.parse(observation);
  const dir = path.join(workspaceDir, storePath, parsed.metric, parsed.input_digest, parsed.evaluator);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${String(parsed.sequence).padStart(12, "0")}.json`);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return path.relative(workspaceDir, target);
}

async function all(workspaceDir: string, storePath: string): Promise<Observation[]> {
  const records: Observation[] = [];
  for (const file of await filesUnder(path.join(workspaceDir, storePath))) {
    const parsed = Observation.safeParse(JSON.parse(await fs.readFile(file, "utf-8")));
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

export async function currentValues(
  workspaceDir: string, storePath: string,
): Promise<Map<string, Observation>> {
  const current = new Map<string, Observation>();
  for (const record of await all(workspaceDir, storePath)) {
    const held = current.get(record.metric);
    if (!held || record.sequence > held.sequence) current.set(record.metric, record);
  }
  return current;
}

/** Flat metric -> value view, which is what acceptance and invariant checks
 * compare before and after a unit. */
export async function snapshotValues(
  workspaceDir: string, storePath: string,
): Promise<Record<string, number>> {
  const snapshot: Record<string, number> = {};
  for (const [metric, observation] of await currentValues(workspaceDir, storePath)) {
    snapshot[metric] = observation.value;
  }
  return snapshot;
}

export async function nextSequence(workspaceDir: string, storePath: string): Promise<number> {
  const records = await all(workspaceDir, storePath);
  return records.reduce((highest, record) => Math.max(highest, record.sequence), 0) + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-observations`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/observations.ts tests/contract-observations.test.ts
git commit -m "feat(workflow): add engine-owned immutable observation store"
```

---

### Task 5: Acceptance, progress and invariant evaluation

**Files:**
- Create: `src/lib/workflow/acceptance.ts`
- Modify: `src/lib/schema.ts` (add `acceptance`, `must_improve`, `must_preserve`, `strategy` to `workUnitFields`)
- Test: `tests/contract-acceptance.test.ts`

**Interfaces:**
- Consumes: `ContractOutcome` (Task 1); snapshots (Task 4).
- Produces: schemas `Criterion`, `ProgressPolicy`, `MustImprove`, `Strategy`; `evaluateContract(input): ContractOutcome` where `input = { acceptance: Criterion[]; must_improve: MustImprove[]; must_preserve: Criterion[]; before: Record<string, number>; after: Record<string, number>; attempts: number; pending: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-acceptance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateContract } from "../src/lib/workflow/acceptance.js";

const coverage = { metric: "test_coverage", operator: "at_least" as const, target: 0.9 };
const progress = { metric: "test_coverage", min_absolute_delta: 0.01, min_gap_fraction: 0.2, max_attempts: 2 };
const rowValidity = { metric: "row_validity", operator: "at_least" as const, target: 1 };

function evaluate(before: Record<string, number>, after: Record<string, number>, extra = {}) {
  return evaluateContract({
    acceptance: [coverage], must_improve: [progress], must_preserve: [rowValidity],
    before, after, attempts: 1, pending: [], ...extra,
  });
}

describe("contract evaluation", () => {
  it("accepts when the target is met and invariants hold", () => {
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.95, row_validity: 1 }))
      .toBe("accepted");
  });

  it("reports improved when progress clears both thresholds short of target", () => {
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.65, row_validity: 1 }))
      .toBe("improved");
  });

  it("rejects a slow crawl that clears the absolute delta but not the gap fraction", () => {
    // +0.02 of a 0.40 gap is 5%: legal twenty times over, which is the failure
    // an absolute-delta-only rule permits.
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.52, row_validity: 1 }))
      .toBe("unmet");
  });

  it("blocks on a broken invariant even when the objective advanced", () => {
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.95, row_validity: 0.8 }))
      .toBe("partially_improved_with_regression");
  });

  it("reports plain regression when nothing advanced and an invariant fell", () => {
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.5, row_validity: 0.8 }))
      .toBe("regressed");
  });

  it("defers while a required measurement is outstanding", () => {
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.95, row_validity: 1 },
      { pending: ["test_coverage"] })).toBe("pending_verification");
  });

  it("never accepts while a measurement is pending", () => {
    const outcome = evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.99, row_validity: 1 },
      { pending: ["test_coverage"] });
    expect(outcome).not.toBe("accepted");
  });

  it("reports strategy_exhausted once attempts are spent without acceptance", () => {
    expect(evaluate({ test_coverage: 0.5, row_validity: 1 }, { test_coverage: 0.52, row_validity: 1 },
      { attempts: 2 })).toBe("strategy_exhausted");
  });

  it("is not_applicable for a unit with no objective", () => {
    expect(evaluateContract({
      acceptance: [], must_improve: [], must_preserve: [], before: {}, after: {}, attempts: 0, pending: [],
    })).toBe("not_applicable");
  });

  it("fails the measurement rather than guessing when a metric is absent", () => {
    expect(evaluate({ row_validity: 1 }, { row_validity: 1 })).toBe("measurement_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-acceptance`
Expected: FAIL — cannot resolve `acceptance.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/acceptance.ts`:

```ts
import { z } from "zod";
import type { ContractOutcome } from "./outcomes.js";

export const Criterion = z.object({
  metric: z.string().min(1),
  operator: z.enum(["at_least", "at_most", "equals"]),
  target: z.number().finite(),
  scope: z.string().min(1).max(160).optional(),
}).strict();
export type Criterion = z.infer<typeof Criterion>;

export const MustImprove = z.object({
  metric: z.string().min(1),
  /** Guards against a metric that moves imperceptibly. */
  min_absolute_delta: z.number().nonnegative().default(0),
  /** Guards against a slow crawl: the fraction of the remaining distance to
   * target that one attempt must close. Both thresholds apply, because a
   * discrete metric moves in lumps near the target while a fine-grained one
   * can inch forever. */
  min_gap_fraction: z.number().min(0).max(1).default(0),
  max_attempts: z.number().int().min(1).default(2),
}).strict();
export type MustImprove = z.infer<typeof MustImprove>;

export const Strategy = z.object({
  key: z.array(z.string().min(1)).min(1),
}).strict();

function satisfies(criterion: Criterion, value: number): boolean {
  if (criterion.operator === "at_least") return value >= criterion.target;
  if (criterion.operator === "at_most") return value <= criterion.target;
  return value === criterion.target;
}

function closedGapFraction(target: number, before: number, after: number, minimize: boolean): number {
  const gap = minimize ? before - target : target - before;
  if (gap <= 0) return 1;
  return (minimize ? before - after : after - before) / gap;
}

export type ContractInput = {
  acceptance: Criterion[];
  must_improve: MustImprove[];
  must_preserve: Criterion[];
  before: Record<string, number>;
  after: Record<string, number>;
  attempts: number;
  /** Metrics whose measurement is deferred past this unit. */
  pending: string[];
};

/** The kernel knows nothing about what any metric means; it compares numbers
 * against declared criteria and returns a typed outcome. */
export function evaluateContract(input: ContractInput): ContractOutcome {
  if (input.acceptance.length === 0 && input.must_improve.length === 0 && input.must_preserve.length === 0) {
    return "not_applicable";
  }

  const regressed = input.must_preserve.some((criterion) => {
    const after = input.after[criterion.metric];
    return typeof after === "number" && !satisfies(criterion, after);
  });

  const required = new Set([
    ...input.acceptance.map((c) => c.metric),
    ...input.must_improve.map((c) => c.metric),
  ]);
  const missing = [...required].filter((metric) => typeof input.after[metric] !== "number");
  const stillPending = [...required].filter((metric) => input.pending.includes(metric));

  // A regression is the most consequential fact about an attempt and reports
  // even when a measurement is outstanding.
  const advanced = input.acceptance.some((criterion) => {
    const before = input.before[criterion.metric];
    const after = input.after[criterion.metric];
    if (typeof before !== "number" || typeof after !== "number") return false;
    return criterion.operator === "at_most" ? after < before : after > before;
  });
  if (regressed) return advanced ? "partially_improved_with_regression" : "regressed";

  if (stillPending.length > 0) return "pending_verification";
  if (missing.length > 0) return "measurement_failed";

  if (input.acceptance.every((criterion) => satisfies(criterion, input.after[criterion.metric]!))) {
    return "accepted";
  }

  let anyImproved = false;
  for (const policy of input.must_improve) {
    const criterion = input.acceptance.find((c) => c.metric === policy.metric);
    if (!criterion) continue;
    const before = input.before[policy.metric] ?? 0;
    const after = input.after[policy.metric]!;
    const minimize = criterion.operator === "at_most";
    const absolute = minimize ? before - after : after - before;
    if (absolute < policy.min_absolute_delta) continue;
    if (closedGapFraction(criterion.target, before, after, minimize) < policy.min_gap_fraction) continue;
    anyImproved = true;
  }
  if (anyImproved) return "improved";

  const exhausted = input.must_improve.some((policy) => input.attempts >= policy.max_attempts);
  return exhausted ? "strategy_exhausted" : "unmet";
}
```

Add to `workUnitFields` in `src/lib/schema.ts`:

```ts
  acceptance: z.array(Criterion).default([]),
  must_improve: z.array(MustImprove).default([]),
  must_preserve: z.array(Criterion).default([]),
  strategy: Strategy.optional(),
```

importing `Criterion`, `MustImprove`, `Strategy` from `./workflow/acceptance.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-acceptance`
Expected: PASS, 10 tests.

- [ ] **Step 5: Regenerate the exported schema and commit**

```bash
npm run schema:export
git add src/lib/workflow/acceptance.ts src/lib/schema.ts schemas/ tests/contract-acceptance.test.ts
git commit -m "feat(workflow): evaluate acceptance, gap-relative progress and protected invariants"
```

---

### Task 6: Effect enforcement — undeclared reads and writes

**Files:**
- Create: `src/lib/workflow/effects.ts`
- Test: `tests/contract-effect-enforcement.test.ts`

**Interfaces:**
- Consumes: `matchesEnvelope` (Task 2); `ContractOutcome` (Task 1).
- Produces: `inventoryWorkspace(dir, ignore: string[]): Promise<Map<string, string>>` (path → sha256); `classifyChanges(before, after, unit): { declared: string[]; owned: string[]; undeclared: string[] }`; `enforceEffects(before, after, unit): ContractOutcome | null` returning `"undeclared_write"` or `null`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-effect-enforcement.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inventoryWorkspace, classifyChanges, enforceEffects } from "../src/lib/workflow/effects.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-effects-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body, "utf-8");
  }
  return dir;
}
const unit = { outputs: ["src/a.ts"], writes: ["src/a.ts"], owns: ["src/**"], allow_unchanged_outputs: [] };

describe("effect enforcement", () => {
  it("ignores engine-owned scheduler state", async () => {
    const dir = await workspace({ "src/a.ts": "one", ".malaclaw/flow/state.json": "{}" });
    const before = await inventoryWorkspace(dir, [".malaclaw"]);
    expect([...before.keys()]).toEqual(["src/a.ts"]);
  });

  it("accepts a change inside the ownership envelope", async () => {
    const dir = await workspace({ "src/a.ts": "one", "src/b.ts": "two" });
    const before = await inventoryWorkspace(dir, [".malaclaw"]);
    await fs.writeFile(path.join(dir, "src/a.ts"), "changed", "utf-8");
    await fs.writeFile(path.join(dir, "src/b.ts"), "also changed", "utf-8");
    const after = await inventoryWorkspace(dir, [".malaclaw"]);
    expect(enforceEffects(before, after, unit)).toBeNull();
  });

  it("rejects a change outside the ownership envelope", async () => {
    const dir = await workspace({ "src/a.ts": "one", "docs/readme.md": "hi" });
    const before = await inventoryWorkspace(dir, [".malaclaw"]);
    await fs.writeFile(path.join(dir, "src/a.ts"), "changed", "utf-8");
    await fs.writeFile(path.join(dir, "docs/readme.md"), "tampered", "utf-8");
    const after = await inventoryWorkspace(dir, [".malaclaw"]);
    expect(enforceEffects(before, after, unit)).toBe("undeclared_write");
  });

  it("treats a newly created file outside the envelope as undeclared", async () => {
    const dir = await workspace({ "src/a.ts": "one" });
    const before = await inventoryWorkspace(dir, [".malaclaw"]);
    await fs.writeFile(path.join(dir, "src/a.ts"), "changed", "utf-8");
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs/new.md"), "new", "utf-8");
    const after = await inventoryWorkspace(dir, [".malaclaw"]);
    expect(enforceEffects(before, after, unit)).toBe("undeclared_write");
  });

  it("permits an owned path that did not change — owns is permission, not obligation", async () => {
    const dir = await workspace({ "src/a.ts": "one", "src/untouched.ts": "same" });
    const before = await inventoryWorkspace(dir, [".malaclaw"]);
    await fs.writeFile(path.join(dir, "src/a.ts"), "changed", "utf-8");
    const after = await inventoryWorkspace(dir, [".malaclaw"]);
    const changes = classifyChanges(before, after, unit);
    expect(changes.undeclared).toEqual([]);
    expect(changes.declared).toEqual(["src/a.ts"]);
  });

  it("reports the exact undeclared paths for the operator diff", async () => {
    const dir = await workspace({ "src/a.ts": "one", "docs/x.md": "x", "docs/y.md": "y" });
    const before = await inventoryWorkspace(dir, [".malaclaw"]);
    await fs.writeFile(path.join(dir, "docs/x.md"), "changed", "utf-8");
    await fs.writeFile(path.join(dir, "docs/y.md"), "changed", "utf-8");
    const after = await inventoryWorkspace(dir, [".malaclaw"]);
    expect(classifyChanges(before, after, unit).undeclared.sort()).toEqual(["docs/x.md", "docs/y.md"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-effect-enforcement`
Expected: FAIL — cannot resolve `effects.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/effects.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { matchesEnvelope } from "../schema.js";
import type { ContractOutcome } from "./outcomes.js";

export type EffectUnit = {
  outputs: string[];
  writes?: string[];
  owns: string[];
  allow_unchanged_outputs: string[];
};

/** Path -> content hash for every file the unit could have touched. Engine
 * state is excluded rather than declared, because attributing scheduler writes
 * to a unit would make every attempt an undeclared write. */
export async function inventoryWorkspace(
  workspaceDir: string, ignore: string[],
): Promise<Map<string, string>> {
  const inventory = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(workspaceDir, full);
      if (ignore.some((prefix) => rel === prefix || rel.startsWith(`${prefix}${path.sep}`))) continue;
      if (entry.isDirectory()) { await walk(full); continue; }
      const bytes = await fs.readFile(full).catch(() => null);
      if (bytes) inventory.set(rel.split(path.sep).join("/"), crypto.createHash("sha256").update(bytes).digest("hex"));
    }
  }
  await walk(workspaceDir);
  return inventory;
}

export function classifyChanges(
  before: Map<string, string>, after: Map<string, string>, unit: EffectUnit,
): { declared: string[]; owned: string[]; undeclared: string[] } {
  const changed: string[] = [];
  for (const [file, digest] of after) if (before.get(file) !== digest) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);

  const declared: string[] = [];
  const owned: string[] = [];
  const undeclared: string[] = [];
  const declaredPaths = new Set([...unit.outputs, ...(unit.writes ?? [])]);
  for (const file of changed) {
    if (declaredPaths.has(file)) declared.push(file);
    else if (unit.owns.some((pattern) => matchesEnvelope(pattern, file))) owned.push(file);
    else undeclared.push(file);
  }
  return { declared: declared.sort(), owned: owned.sort(), undeclared: undeclared.sort() };
}

/** A unit with no declared envelope keeps the historical behavior: `owns` is
 * opt-in, so IR v2 does not retroactively fence units that never declared one. */
export function enforceEffects(
  before: Map<string, string>, after: Map<string, string>, unit: EffectUnit,
): ContractOutcome | null {
  if (unit.owns.length === 0) return null;
  return classifyChanges(before, after, unit).undeclared.length > 0 ? "undeclared_write" : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-effect-enforcement`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/effects.ts tests/contract-effect-enforcement.test.ts
git commit -m "feat(workflow): enforce write envelopes and detect undeclared writes"
```

---

### Task 7: Strategy fingerprints and per-objective stagnation

**Files:**
- Create: `src/lib/workflow/stagnation.ts`
- Test: `tests/contract-stagnation.test.ts`

**Interfaces:**
- Consumes: `Criterion` (Task 5); `ContractOutcome` (Task 1).
- Produces: `objectiveKey(criterion, findingIds, artifactIds): string`; `strategyFingerprint(objective, capability, effect): string`; `ObjectiveProgress` schema (`objective`, `before`, `after`, `consecutive_unmet`, `strategies_attempted`); `recordAttempt(state, objective, fingerprint, outcome, before, after): ObjectiveProgress`; `isRepeatedStrategy(state, objective, fingerprint): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-stagnation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  objectiveKey, strategyFingerprint, recordAttempt, isRepeatedStrategy,
} from "../src/lib/workflow/stagnation.js";

const coverage = { metric: "test_coverage", operator: "at_least" as const, target: 0.9 };
const moduleA = { ...coverage, scope: "module-a" };
const moduleB = { ...coverage, scope: "module-b" };

describe("per-objective stagnation", () => {
  it("keys an objective by scope so one scope cannot reset another", () => {
    expect(objectiveKey(moduleA, ["f1"], ["src/a.ts"]))
      .not.toBe(objectiveKey(moduleB, ["f1"], ["src/b.ts"]));
  });

  it("keys an objective by target so a lowered bar is a different objective", () => {
    expect(objectiveKey(coverage, [], [])).not.toBe(objectiveKey({ ...coverage, target: 0.5 }, [], []));
  });

  it("counts consecutive unmet attempts per objective", () => {
    const key = objectiveKey(moduleA, [], []);
    let state = {};
    state = recordAttempt(state, key, "s1", "unmet", 0.5, 0.5).state;
    const second = recordAttempt(state, key, "s2", "unmet", 0.5, 0.5);
    expect(second.progress.consecutive_unmet).toBe(2);
  });

  it("does not reset one objective when a different objective improves", () => {
    const a = objectiveKey(moduleA, [], []);
    const b = objectiveKey(moduleB, [], []);
    let state = {};
    state = recordAttempt(state, a, "s1", "unmet", 0.5, 0.5).state;
    state = recordAttempt(state, a, "s2", "unmet", 0.5, 0.5).state;
    state = recordAttempt(state, b, "s3", "accepted", 0.5, 0.95).state;
    const third = recordAttempt(state, a, "s4", "unmet", 0.5, 0.5);
    expect(third.progress.consecutive_unmet).toBe(3);
  });

  it("resets the counter when the objective itself improves", () => {
    const key = objectiveKey(moduleA, [], []);
    let state = {};
    state = recordAttempt(state, key, "s1", "unmet", 0.5, 0.5).state;
    const improved = recordAttempt(state, key, "s2", "improved", 0.5, 0.7);
    expect(improved.progress.consecutive_unmet).toBe(0);
  });

  it("rejects an identical fingerprint against an unchanged objective", () => {
    const key = objectiveKey(moduleA, [], []);
    const fingerprint = strategyFingerprint(key, "repair_module", "rewrite_tests");
    const { state } = recordAttempt({}, key, fingerprint, "unmet", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, fingerprint)).toBe(true);
  });

  it("allows a different capability against the same objective", () => {
    const key = objectiveKey(moduleA, [], []);
    const first = strategyFingerprint(key, "repair_module", "rewrite_tests");
    const second = strategyFingerprint(key, "restructure_module", "rewrite_tests");
    const { state } = recordAttempt({}, key, first, "unmet", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, second)).toBe(false);
  });

  it("does not count a quota interruption as an attempted strategy", () => {
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
import type { Criterion } from "./acceptance.js";
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
 *
 * Keyed on the metric alone, an improvement at one scope resets the counter for
 * every other scope — a slow crawl wearing the appearance of progress. */
export function objectiveKey(criterion: Criterion, findingIds: string[], artifactIds: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    criterion.metric, criterion.operator, criterion.target, criterion.scope ?? "",
    [...findingIds].sort(), [...artifactIds].sort(),
  ])).digest("hex").slice(0, 32);
}

export function strategyFingerprint(objective: string, capability: string, effect: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([objective, capability, effect]))
    .digest("hex").slice(0, 32);
}

/** Outcomes that represent a strategy actually having been tried. An execution
 * interruption is not one: counting a quota pause as a failed strategy would
 * burn the objective's attempt budget on an infrastructure event. */
const COUNTS_AS_ATTEMPT: ReadonlySet<ContractOutcome> = new Set<ContractOutcome>([
  "unmet", "stalled", "improved", "accepted", "regressed",
  "partially_improved_with_regression", "strategy_exhausted",
]);

export function recordAttempt(
  state: StagnationState,
  objective: string,
  fingerprint: string,
  outcome: ContractOutcome,
  before: number,
  after: number,
): { state: StagnationState; progress: ObjectiveProgress } {
  const held = state[objective] ?? ObjectiveProgress.parse({ objective });
  if (!COUNTS_AS_ATTEMPT.has(outcome)) return { state, progress: held };

  const advanced = outcome === "accepted" || outcome === "improved";
  const progress = ObjectiveProgress.parse({
    objective,
    before: held.before ?? before,
    after,
    consecutive_unmet: advanced ? 0 : held.consecutive_unmet + 1,
    strategies_attempted: held.strategies_attempted.includes(fingerprint)
      ? held.strategies_attempted
      : [...held.strategies_attempted, fingerprint],
  });
  return { state: { ...state, [objective]: progress }, progress };
}

export function isRepeatedStrategy(
  state: StagnationState, objective: string, fingerprint: string,
): boolean {
  return (state[objective]?.strategies_attempted ?? []).includes(fingerprint);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-stagnation`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/stagnation.ts tests/contract-stagnation.test.ts
git commit -m "feat(workflow): track stagnation per objective with strategy fingerprints"
```

---

### Task 8: Attempt journal and idempotent effect reconciliation

**Files:**
- Create: `src/lib/workflow/attempts.ts`
- Test: `tests/contract-attempts.test.ts`

**Interfaces:**
- Consumes: `ExecutionOutcome` (Task 1).
- Produces: `AttemptState` enum (`prepared`, `dispatched`, `applied`, `measured`, `committed`, `interrupted`, `failed`, `cancelled`, `uncertain`, `reconciled`); `AttemptRecord` schema (`invocation_id`, `idempotency_key`, `unit_key`, `attempt_state`, `intended_effects`, `applied_effects`, `sequence`); `idempotencyKey(unitKey, objective, strategy, inputDigest)`; `journalAttempt(dir, record)`; `readAttempts(dir, unitKey)`; `reconcile(dir, unitKey): Promise<{ resumable: AttemptRecord[]; uncertain: AttemptRecord[] }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-attempts.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  idempotencyKey, journalAttempt, readAttempts, reconcile,
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
function attempt(overrides: Record<string, unknown> = {}) {
  return {
    invocation_id: "inv-1", idempotency_key: "k1", unit_key: "repair",
    attempt_state: "prepared", intended_effects: ["src/a.ts"], applied_effects: [],
    sequence: 1, ...overrides,
  };
}

describe("attempt journal", () => {
  it("derives a stable idempotency key from unit, objective, strategy and inputs", () => {
    const a = idempotencyKey("repair", "obj1", "strat1", "d".repeat(64));
    const b = idempotencyKey("repair", "obj1", "strat1", "d".repeat(64));
    const c = idempotencyKey("repair", "obj1", "strat1", "e".repeat(64));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("journals intended effects before dispatch", async () => {
    const dir = await workspace();
    await journalAttempt(dir, attempt() as never);
    const records = await readAttempts(dir, "repair");
    expect(records[0].attempt_state).toBe("prepared");
    expect(records[0].intended_effects).toEqual(["src/a.ts"]);
  });

  it("treats an attempt left in dispatched with unapplied effects as uncertain", async () => {
    const dir = await workspace();
    await journalAttempt(dir, attempt({ attempt_state: "dispatched" }) as never);
    const result = await reconcile(dir, "repair");
    expect(result.uncertain).toHaveLength(1);
    expect(result.resumable).toHaveLength(0);
  });

  it("treats a committed attempt as neither uncertain nor resumable", async () => {
    const dir = await workspace();
    await journalAttempt(dir, attempt({ attempt_state: "committed", applied_effects: ["src/a.ts"] }) as never);
    const result = await reconcile(dir, "repair");
    expect(result.uncertain).toHaveLength(0);
    expect(result.resumable).toHaveLength(0);
  });

  it("treats an interrupted attempt with no applied effects as safely resumable", async () => {
    const dir = await workspace();
    await journalAttempt(dir, attempt({ attempt_state: "interrupted" }) as never);
    const result = await reconcile(dir, "repair");
    expect(result.resumable).toHaveLength(1);
  });

  it("never auto-redispatches an uncertain external effect", async () => {
    const dir = await workspace();
    await journalAttempt(dir, attempt({
      attempt_state: "dispatched", intended_effects: ["provider:search"],
    }) as never);
    const result = await reconcile(dir, "repair");
    // The guarantee is at-least-once with idempotent effects, not exactly-once:
    // a provider that succeeded but lost its acknowledgment must be reconciled,
    // never replayed on the engine's own initiative.
    expect(result.uncertain[0].intended_effects).toEqual(["provider:search"]);
    expect(result.resumable).toHaveLength(0);
  });

  it("keeps the latest record per invocation rather than duplicating history", async () => {
    const dir = await workspace();
    await journalAttempt(dir, attempt({ attempt_state: "prepared" }) as never);
    await journalAttempt(dir, attempt({ attempt_state: "applied", sequence: 2 }) as never);
    const records = await readAttempts(dir, "repair");
    expect(records).toHaveLength(1);
    expect(records[0].attempt_state).toBe("applied");
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

const DIR = path.join(".malaclaw", "attempts");

export const AttemptState = z.enum([
  "prepared", "dispatched", "applied", "measured", "committed",
  "interrupted", "failed", "cancelled", "uncertain", "reconciled",
]);
export type AttemptState = z.infer<typeof AttemptState>;

export const AttemptRecord = z.object({
  invocation_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  unit_key: z.string().min(1),
  attempt_state: AttemptState,
  /** Declared before dispatch, so a crash leaves a record of what was about to
   * happen rather than only of what finished. */
  intended_effects: z.array(z.string().min(1)).default([]),
  applied_effects: z.array(z.string().min(1)).default([]),
  sequence: z.number().int().nonnegative(),
}).strict();
export type AttemptRecord = z.infer<typeof AttemptRecord>;

export function idempotencyKey(
  unitKey: string, objective: string, strategy: string, inputDigest: string,
): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify([unitKey, objective, strategy, inputDigest]))
    .digest("hex");
}

function file(workspaceDir: string, unitKey: string, invocationId: string): string {
  return path.join(workspaceDir, DIR, unitKey, `${invocationId}.json`);
}

export async function journalAttempt(workspaceDir: string, record: AttemptRecord): Promise<void> {
  const parsed = AttemptRecord.parse(record);
  const target = file(workspaceDir, parsed.unit_key, parsed.invocation_id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readAttempts(workspaceDir: string, unitKey: string): Promise<AttemptRecord[]> {
  const dir = path.join(workspaceDir, DIR, unitKey);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const records: AttemptRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = AttemptRecord.safeParse(JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")));
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

/** Conservative by construction.
 *
 * An attempt that reached `dispatched` may or may not have landed its effects,
 * and no amount of local state can tell us which. Replaying it risks a
 * duplicate provider call, a duplicate paid render, or a second release; so it
 * is reported as uncertain and requires explicit reconciliation. */
export async function reconcile(
  workspaceDir: string, unitKey: string,
): Promise<{ resumable: AttemptRecord[]; uncertain: AttemptRecord[] }> {
  const resumable: AttemptRecord[] = [];
  const uncertain: AttemptRecord[] = [];
  for (const record of await readAttempts(workspaceDir, unitKey)) {
    if (record.attempt_state === "committed" || record.attempt_state === "reconciled") continue;
    if (record.attempt_state === "dispatched" || record.attempt_state === "uncertain") {
      uncertain.push(record);
      continue;
    }
    if (record.applied_effects.length === 0) resumable.push(record);
    else uncertain.push(record);
  }
  return { resumable, uncertain };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-attempts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/attempts.ts tests/contract-attempts.test.ts
git commit -m "feat(workflow): journal attempts and reconcile uncertain effects after a crash"
```

---

### Task 9: Leases, progress heartbeats and orphan states

**Files:**
- Create: `src/lib/workflow/leases.ts`
- Test: `tests/contract-leases.test.ts`

**Interfaces:**
- Consumes: `AttemptRecord` (Task 8).
- Produces: `Lease` schema (`lease_owner`, `lease_expires_at`, `last_progress_sequence`, `last_progress_at`, `renewals_without_progress`, `checkpoint?`); `AttemptHealth` type; `classifyHealth(lease, attempt, now, policy): AttemptHealth`; `renewLease(lease, owner, ttlMs, progressSequence, now): Lease`.

`AttemptHealth` values: `running_progressing`, `running_stalled`, `worker_lost`, `provider_uncertain`, `resumable`, `requires_reconciliation`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-leases.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyHealth, renewLease } from "../src/lib/workflow/leases.js";

const POLICY = { stalled_renewals: 3, stalled_ms: 600_000 };
const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const clean = { invocation_id: "i1", idempotency_key: "k", unit_key: "u", attempt_state: "dispatched" as const, intended_effects: [], applied_effects: [], sequence: 1 };

function lease(overrides: Record<string, unknown> = {}) {
  return {
    lease_owner: "worker-17",
    lease_expires_at: new Date(NOW + 60_000).toISOString(),
    last_progress_sequence: 42,
    last_progress_at: new Date(NOW - 1_000).toISOString(),
    renewals_without_progress: 0,
    ...overrides,
  };
}

describe("leases and orphan recovery", () => {
  it("reports a live attempt with recent progress as progressing", () => {
    expect(classifyHealth(lease(), clean, NOW, POLICY)).toBe("running_progressing");
  });

  it("reports a live attempt with no progress as stalled, not terminated", () => {
    // Long-running is not the same as dead: this must never end the attempt.
    const health = classifyHealth(lease({ renewals_without_progress: 4 }), clean, NOW, POLICY);
    expect(health).toBe("running_stalled");
  });

  it("uses elapsed time since the last progress event as an alternative stall signal", () => {
    const stale = lease({ last_progress_at: new Date(NOW - 700_000).toISOString() });
    expect(classifyHealth(stale, clean, NOW, POLICY)).toBe("running_stalled");
  });

  it("does not terminate an attempt merely because it has run a long time", () => {
    const long = lease({ last_progress_at: new Date(NOW - 1_000).toISOString(), renewals_without_progress: 0 });
    expect(classifyHealth(long, clean, NOW + 3_600_000 - 60_000, POLICY)).not.toBe("worker_lost");
  });

  it("reports an expired lease with no applied effects as worker_lost", () => {
    const expired = lease({ lease_expires_at: new Date(NOW - 1).toISOString() });
    expect(classifyHealth(expired, { ...clean, attempt_state: "interrupted" }, NOW, POLICY)).toBe("worker_lost");
  });

  it("reports an expired lease mid-dispatch as provider_uncertain", () => {
    const expired = lease({ lease_expires_at: new Date(NOW - 1).toISOString() });
    expect(classifyHealth(expired, clean, NOW, POLICY)).toBe("provider_uncertain");
  });

  it("reports an expired lease with applied effects as requiring reconciliation", () => {
    const expired = lease({ lease_expires_at: new Date(NOW - 1).toISOString() });
    const applied = { ...clean, attempt_state: "interrupted" as const, applied_effects: ["provider:call"] };
    expect(classifyHealth(expired, applied, NOW, POLICY)).toBe("requires_reconciliation");
  });

  it("resets the no-progress counter when the progress sequence advances", () => {
    const renewed = renewLease(lease({ renewals_without_progress: 5 }), "worker-17", 60_000, 43, NOW);
    expect(renewed.renewals_without_progress).toBe(0);
    expect(renewed.last_progress_sequence).toBe(43);
  });

  it("increments the no-progress counter when the sequence is unchanged", () => {
    const renewed = renewLease(lease({ renewals_without_progress: 1 }), "worker-17", 60_000, 42, NOW);
    expect(renewed.renewals_without_progress).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-leases`
Expected: FAIL — cannot resolve `leases.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/leases.ts`:

```ts
import { z } from "zod";
import type { AttemptRecord } from "./attempts.js";

export const Lease = z.object({
  lease_owner: z.string().min(1),
  lease_expires_at: z.string().datetime(),
  last_progress_sequence: z.number().int().nonnegative(),
  last_progress_at: z.string().datetime(),
  /** Consecutive renewals during which the progress sequence did not move.
   * Counting renewals rather than "no progress for N sequences" matters: if
   * progress never happens, a sequence-based counter never advances either. */
  renewals_without_progress: z.number().int().nonnegative().default(0),
  checkpoint: z.string().min(1).optional(),
}).strict();
export type Lease = z.infer<typeof Lease>;

export type AttemptHealth =
  | "running_progressing" | "running_stalled" | "worker_lost"
  | "provider_uncertain" | "resumable" | "requires_reconciliation";

export type StallPolicy = { stalled_renewals: number; stalled_ms: number };

/** A wall-clock timeout is a poor definition of failure: a legitimate long
 * retrieval and a dead worker look identical to it. Only lease expiry
 * terminates an attempt; elapsed time can at most mark it stalled, which
 * triggers diagnosis. */
export function classifyHealth(
  lease: Lease, attempt: AttemptRecord, now: number, policy: StallPolicy,
): AttemptHealth {
  const expired = Date.parse(lease.lease_expires_at) <= now;
  if (!expired) {
    const sinceProgress = now - Date.parse(lease.last_progress_at);
    const stalled = lease.renewals_without_progress >= policy.stalled_renewals
      || sinceProgress >= policy.stalled_ms;
    return stalled ? "running_stalled" : "running_progressing";
  }
  if (attempt.applied_effects.length > 0) return "requires_reconciliation";
  if (attempt.attempt_state === "dispatched" || attempt.attempt_state === "uncertain") {
    return "provider_uncertain";
  }
  return "worker_lost";
}

export function renewLease(
  lease: Lease, owner: string, ttlMs: number, progressSequence: number, now: number,
): Lease {
  const advanced = progressSequence > lease.last_progress_sequence;
  return Lease.parse({
    lease_owner: owner,
    lease_expires_at: new Date(now + ttlMs).toISOString(),
    last_progress_sequence: progressSequence,
    last_progress_at: advanced ? new Date(now).toISOString() : lease.last_progress_at,
    renewals_without_progress: advanced ? 0 : lease.renewals_without_progress + 1,
    checkpoint: lease.checkpoint,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-leases`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/leases.ts tests/contract-leases.test.ts
git commit -m "feat(workflow): add renewable leases, progress heartbeats and orphan classification"
```

---

### Task 10: Write-conflict graph for concurrent mutations

**Files:**
- Create: `src/lib/workflow/conflicts.ts`
- Test: `tests/contract-conflicts.test.ts`

**Interfaces:**
- Consumes: `matchesEnvelope` (Task 2).
- Produces: `envelopesOverlap(a: string[], b: string[]): boolean`; `conflictGraph(units): Map<string, Set<string>>`; `schedulableBatches(units): string[][]`; `exclusiveLeasePaths(units): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-conflicts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { envelopesOverlap, conflictGraph, schedulableBatches } from "../src/lib/workflow/conflicts.js";

const sectionA = { id: "write_a", kind: "mutation" as const, owns: ["src/a/**"], reads: ["shared/**"] };
const sectionB = { id: "write_b", kind: "mutation" as const, owns: ["src/b/**"], reads: ["shared/**"] };
const shared = { id: "write_shared", kind: "mutation" as const, owns: ["shared/registry.json"], reads: [] };
const alsoShared = { id: "write_shared_2", kind: "mutation" as const, owns: ["shared/**"], reads: [] };
const measure = { id: "measure", kind: "measurement" as const, owns: [], reads: ["src/**"] };

describe("write-conflict graph", () => {
  it("detects overlap between an exact path and a covering glob", () => {
    expect(envelopesOverlap(["shared/registry.json"], ["shared/**"])).toBe(true);
  });

  it("reports disjoint envelopes as non-overlapping", () => {
    expect(envelopesOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
  });

  it("lets mutations with disjoint envelopes run in the same batch", () => {
    const batches = schedulableBatches([sectionA, sectionB]);
    expect(batches).toHaveLength(1);
    expect(batches[0].sort()).toEqual(["write_a", "write_b"]);
  });

  it("serializes two mutations whose envelopes overlap", () => {
    const batches = schedulableBatches([shared, alsoShared]);
    expect(batches).toHaveLength(2);
  });

  it("lets measurements run alongside mutations they only read", () => {
    const batches = schedulableBatches([sectionA, measure]);
    expect(batches).toHaveLength(1);
  });

  it("records the conflict edge in both directions", () => {
    const graph = conflictGraph([shared, alsoShared]);
    expect(graph.get("write_shared")?.has("write_shared_2")).toBe(true);
    expect(graph.get("write_shared_2")?.has("write_shared")).toBe(true);
  });

  it("does not conflict two units that merely read the same paths", () => {
    const graph = conflictGraph([sectionA, sectionB]);
    expect(graph.get("write_a")?.size ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-conflicts`
Expected: FAIL — cannot resolve `conflicts.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/conflicts.ts`:

```ts
import { matchesEnvelope } from "../schema.js";

export type ConflictUnit = {
  id: string;
  kind: "plain" | "mutation" | "measurement";
  owns: string[];
  reads: string[];
};

function covers(pattern: string, other: string): boolean {
  if (matchesEnvelope(pattern, other)) return true;
  if (other.endsWith("/**")) return matchesEnvelope(other, pattern) || pattern.startsWith(other.slice(0, -2));
  return false;
}

export function envelopesOverlap(a: string[], b: string[]): boolean {
  return a.some((left) => b.some((right) => covers(left, right) || covers(right, left)));
}

/** Prevention, not detection.
 *
 * Hashing after the fact proves two workers raced on the same artifact; it does
 * not stop them. Units whose write envelopes intersect are serialized before
 * either one starts. Measurements own nothing, so they never conflict. */
export function conflictGraph(units: ConflictUnit[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>(units.map((unit) => [unit.id, new Set<string>()]));
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const left = units[i]!;
      const right = units[j]!;
      if (left.owns.length === 0 || right.owns.length === 0) continue;
      if (!envelopesOverlap(left.owns, right.owns)) continue;
      graph.get(left.id)!.add(right.id);
      graph.get(right.id)!.add(left.id);
    }
  }
  return graph;
}

/** Greedy graph colouring: each batch is an independent set, so everything in
 * one batch may run concurrently. */
export function schedulableBatches(units: ConflictUnit[]): string[][] {
  const graph = conflictGraph(units);
  const batches: string[][] = [];
  const placed = new Set<string>();
  for (const unit of units) {
    if (placed.has(unit.id)) continue;
    let batch = batches.find((candidate) => candidate.every((id) => !graph.get(unit.id)!.has(id)));
    if (!batch) { batch = []; batches.push(batch); }
    batch.push(unit.id);
    placed.add(unit.id);
  }
  return batches;
}

/** Paths owned by more than one unit need an exclusive lease while held. */
export function exclusiveLeasePaths(units: ConflictUnit[]): string[] {
  const counts = new Map<string, number>();
  for (const unit of units) {
    for (const pattern of unit.owns) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([pattern]) => pattern).sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-conflicts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/conflicts.ts tests/contract-conflicts.test.ts
git commit -m "feat(workflow): serialize mutations with overlapping write envelopes"
```

---

### Task 11: Run pinning

**Files:**
- Create: `src/lib/workflow/pinning.ts`
- Modify: `src/lib/workflow/state.ts` (add `pinDigest` to `FlowState`)
- Test: `tests/contract-pinning.test.ts`

**Interfaces:**
- Consumes: `WorkflowDef` (Task 2).
- Produces: `RunPin` schema (`ir_version`, `manifest_digest`, `registry_versions`, `prompt_versions`, `model_profile`, `evaluator_configuration`, `tool_versions`); `computePin(workflow, environment): RunPin`; `pinDigest(pin): string`; `assertPinMatches(recorded, current): void` throwing `PinMismatchError`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-pinning.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WorkflowDef } from "../src/lib/schema.js";
import { computePin, pinDigest, assertPinMatches, PinMismatchError } from "../src/lib/workflow/pinning.js";

const wf = WorkflowDef.parse({ stages: [{ id: "a", owner: "x", outputs: ["a.md"] }] });
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

  it("changes the digest when a prompt version changes", () => {
    const changed = { ...env, prompt_versions: { plan: "4" } };
    expect(pinDigest(computePin(wf, changed))).not.toBe(pinDigest(computePin(wf, env)));
  });

  it("changes the digest when the model profile changes", () => {
    const changed = { ...env, model_profile: "economy" };
    expect(pinDigest(computePin(wf, changed))).not.toBe(pinDigest(computePin(wf, env)));
  });

  it("changes the digest when a registry version changes", () => {
    const changed = { ...env, registry_versions: { metric: "2", finding: "1" } };
    expect(pinDigest(computePin(wf, changed))).not.toBe(pinDigest(computePin(wf, env)));
  });

  it("accepts a resume under the pinned definition", () => {
    const pin = computePin(wf, env);
    expect(() => assertPinMatches(pin, computePin(wf, env))).not.toThrow();
  });

  it("fails a resume under a changed definition rather than silently proceeding", () => {
    const pin = computePin(wf, env);
    const drifted = computePin(wf, { ...env, model_profile: "economy" });
    expect(() => assertPinMatches(pin, drifted)).toThrow(PinMismatchError);
  });

  it("names what drifted so the operator can decide", () => {
    const pin = computePin(wf, env);
    const drifted = computePin(wf, { ...env, prompt_versions: { plan: "9" } });
    try {
      assertPinMatches(pin, drifted);
    } catch (error) {
      expect((error as Error).message).toMatch(/prompt_versions/);
      expect((error as Error).message).toMatch(/migration/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-pinning`
Expected: FAIL — cannot resolve `pinning.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/pinning.ts`:

```ts
import crypto from "node:crypto";
import { z } from "zod";
import type { WorkflowDef } from "../schema.js";
import { workflowHash } from "./state.js";

export const RunPin = z.object({
  ir_version: z.number().int().min(1),
  manifest_digest: z.string().min(1),
  registry_versions: z.record(z.string()),
  prompt_versions: z.record(z.string()),
  model_profile: z.string().min(1),
  evaluator_configuration: z.string().min(1),
  tool_versions: z.record(z.string()),
}).strict();
export type RunPin = z.infer<typeof RunPin>;

export type PinEnvironment = Omit<RunPin, "ir_version" | "manifest_digest">;

export class PinMismatchError extends Error {
  constructor(readonly fields: string[]) {
    super(
      `the run definition changed since this flow started (${fields.join(", ")}). ` +
      `A paused run resumes against its pinned definition or requires an explicit migration. ` +
      `Resuming under a changed definition would make prior observations incomparable with new ones.`,
    );
    this.name = "PinMismatchError";
  }
}

export function computePin(workflow: WorkflowDef, environment: PinEnvironment): RunPin {
  return RunPin.parse({
    ir_version: workflow.ir_version,
    manifest_digest: workflowHash(workflow),
    ...environment,
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : nested);
}

export function pinDigest(pin: RunPin): string {
  return crypto.createHash("sha256").update(canonical(pin)).digest("hex").slice(0, 32);
}

/** During the POC this is deliberately a hard failure rather than an automatic
 * migration: a silent resume under changed prompts or registries is the same
 * class of error as resolving observation freshness by wall clock. */
export function assertPinMatches(recorded: RunPin, current: RunPin): void {
  const drifted = (Object.keys(RunPin.shape) as (keyof RunPin)[])
    .filter((field) => canonical(recorded[field]) !== canonical(current[field]));
  if (drifted.length > 0) throw new PinMismatchError(drifted as string[]);
}
```

Add `pinDigest: z.string().optional()` to `FlowState` in `src/lib/workflow/state.ts` and record it in `initFlowState`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-pinning`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/pinning.ts src/lib/workflow/state.ts tests/contract-pinning.test.ts
git commit -m "feat(workflow): pin the run definition and fail a drifted resume explicitly"
```

---

### Task 12: Blocked-workspace state and `flow repair-block`

**Files:**
- Create: `src/lib/workflow/blocks.ts`
- Modify: `src/lib/workflow/state.ts` (add `blocks` to `FlowState`)
- Modify: `src/commands/flow.ts` (register `repair-block`)
- Test: `tests/contract-blocks.test.ts`

**Interfaces:**
- Consumes: `ContractOutcome`, `blocksWorkspace` (Task 1).
- Produces: `Block` schema (`id`, `outcome`, `unit_key`, `objective`, `before`, `after`, `changed_files`, `created_at`, `cleared_at?`, `cleared_by?`); `raiseBlock(state, block)`; `activeBlocks(state)`; `assertRunnable(state)` throwing `BlockedWorkspaceError`; `clearBlock(state, id, clearedBy)`; `isCorrectiveDispatch(state, blockId, capability): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-blocks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  raiseBlock, activeBlocks, assertRunnable, clearBlock,
  isCorrectiveDispatch, BlockedWorkspaceError,
} from "../src/lib/workflow/blocks.js";

const block = {
  id: "b1", outcome: "regressed" as const, unit_key: "repair", objective: "obj1",
  before: { row_validity: 1 }, after: { row_validity: 0.8 },
  changed_files: ["data/rows.csv"], created_at: "2026-09-01T12:00:00.000Z",
  corrective_capability: "restore_rows",
};

describe("blocked workspace", () => {
  it("records a block with its before/after snapshot and changed files", () => {
    const state = raiseBlock({ blocks: [] }, block);
    expect(activeBlocks(state)).toHaveLength(1);
    expect(activeBlocks(state)[0].changed_files).toEqual(["data/rows.csv"]);
  });

  it("refuses ordinary execution while a block stands", () => {
    const state = raiseBlock({ blocks: [] }, block);
    expect(() => assertRunnable(state)).toThrow(BlockedWorkspaceError);
  });

  it("names the standing block so the operator knows which one", () => {
    const state = raiseBlock({ blocks: [] }, block);
    try {
      assertRunnable(state);
    } catch (error) {
      expect((error as Error).message).toMatch(/b1/);
      expect((error as Error).message).toMatch(/repair-block/);
    }
  });

  it("permits only the designated corrective capability while blocked", () => {
    const state = raiseBlock({ blocks: [] }, block);
    expect(isCorrectiveDispatch(state, "b1", "restore_rows")).toBe(true);
    expect(isCorrectiveDispatch(state, "b1", "keep_going")).toBe(false);
  });

  it("runs again once the block is cleared", () => {
    let state = raiseBlock({ blocks: [] }, block);
    state = clearBlock(state, "b1", "operator");
    expect(() => assertRunnable(state)).not.toThrow();
    expect(activeBlocks(state)).toHaveLength(0);
  });

  it("keeps a cleared block in history rather than deleting it", () => {
    let state = raiseBlock({ blocks: [] }, block);
    state = clearBlock(state, "b1", "operator");
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].cleared_by).toBe("operator");
  });

  it("does not raise a block for an outcome that only pauses", () => {
    const state = raiseBlock({ blocks: [] }, { ...block, id: "b2", outcome: "unmet" });
    expect(activeBlocks(state)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-blocks`
Expected: FAIL — cannot resolve `blocks.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/workflow/blocks.ts`:

```ts
import { z } from "zod";
import { ContractOutcome, blocksWorkspace } from "./outcomes.js";

export const Block = z.object({
  id: z.string().min(1),
  outcome: ContractOutcome,
  unit_key: z.string().min(1),
  objective: z.string().min(1),
  before: z.record(z.number()).default({}),
  after: z.record(z.number()).default({}),
  changed_files: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  /** The only capability permitted to run while this block stands. */
  corrective_capability: z.string().min(1).optional(),
  cleared_at: z.string().datetime().optional(),
  cleared_by: z.string().min(1).optional(),
}).strict();
export type Block = z.infer<typeof Block>;

export type BlockedState = { blocks: Block[] };

export class BlockedWorkspaceError extends Error {
  constructor(readonly blocks: Block[]) {
    super(
      `the workspace has ${blocks.length} unresolved block(s): ` +
      blocks.map((block) => `${block.id} (${block.outcome} on ${block.unit_key})`).join(", ") +
      `. Clear it with \`malaclaw flow repair-block <block-id> --action <capability>\`, ` +
      `or record an operator decision. Ordinary execution stays prohibited until then.`,
    );
    this.name = "BlockedWorkspaceError";
  }
}

/** Only outcomes whose policy is `block` mark the workspace. `pause` halts the
 * run without preventing a later unit from running. */
export function raiseBlock(state: BlockedState, block: Block): BlockedState {
  const parsed = Block.parse(block);
  if (!blocksWorkspace(parsed.outcome)) return state;
  return { ...state, blocks: [...state.blocks, parsed] };
}

export function activeBlocks(state: BlockedState): Block[] {
  return state.blocks.filter((block) => !block.cleared_at);
}

/** Without this, "fail the action but keep the writes" degrades into the
 * advisory telemetry it was meant to replace. */
export function assertRunnable(state: BlockedState): void {
  const active = activeBlocks(state);
  if (active.length > 0) throw new BlockedWorkspaceError(active);
}

export function isCorrectiveDispatch(state: BlockedState, blockId: string, capability: string): boolean {
  const block = activeBlocks(state).find((candidate) => candidate.id === blockId);
  return block?.corrective_capability === capability;
}

export function clearBlock(state: BlockedState, id: string, clearedBy: string): BlockedState {
  return {
    ...state,
    blocks: state.blocks.map((block) => block.id === id && !block.cleared_at
      ? Block.parse({ ...block, cleared_at: new Date().toISOString(), cleared_by: clearedBy })
      : block),
  };
}
```

Add `blocks: z.array(Block).default([])` to `FlowState`. Register in `src/commands/flow.ts`:

```ts
flow
  .command("repair-block <blockId>")
  .description("Dispatch only the designated corrective action for a standing block")
  .requiredOption("--action <capability>", "the corrective capability declared by the block")
  .action(async (blockId, options) => {
    const { runFlowRepairBlock } = await import("../lib/workflow/repair-block.js");
    await runFlowRepairBlock(process.cwd(), blockId, options.action);
  });
```

Call `assertRunnable(state)` at the top of the existing `flow run` and `flow continue` paths.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-blocks`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/blocks.ts src/lib/workflow/state.ts src/commands/flow.ts tests/contract-blocks.test.ts
git commit -m "feat(workflow): block the workspace on regression and add flow repair-block"
```

---

### Task 13: Engine integration — the contract cycle

Wires Tasks 1–12 into the scheduler so a real unit produces a typed outcome.

**Files:**
- Modify: `src/lib/workflow/engine.ts`
- Test: `tests/contract-engine-cycle.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1–12.
- Produces: the engine records `executionOutcome` and `contractOutcome` on `UnitState`, and applies `executionAction` / `contractAction`.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-engine-cycle.test.ts`. Use the `dry-run` runtime and a script measurement unit so the test is hermetic and domain-neutral:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowDef } from "../src/lib/schema.js";
import { runFlow } from "../src/lib/workflow/engine.js";
import { loadFlowState } from "../src/lib/workflow/state.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "malaclaw-cycle-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
  return dir;
}

/** A domain-neutral fixture: a code repair whose objective is test coverage. */
function workflow(coverageAfter: number) {
  return WorkflowDef.parse({
    ir_version: 2,
    stages: [
      {
        id: "repair", owner: "eng", kind: "mutation", runtime: "dry-run",
        reads: ["src/**"], writes: ["src/a.ts"], owns: ["src/**"], outputs: ["src/a.ts"],
        evaluate_with: ["measure"],
        acceptance: [{ metric: "test_coverage", operator: "at_least", target: 0.9 }],
        must_improve: [{ metric: "test_coverage", min_absolute_delta: 0.01, min_gap_fraction: 0.2, max_attempts: 2 }],
        must_preserve: [{ metric: "row_validity", operator: "at_least", target: 1 }],
      },
      {
        id: "measure", owner: "ci", kind: "measurement", runtime: "script",
        reads: ["src/**"], writes_observations: ["test_coverage", "row_validity"],
        command: { cmd: "node", args: ["-e", `require("fs").writeFileSync(process.env.OUT, String(${coverageAfter}))`] },
      },
    ],
  });
}

describe("engine contract cycle", () => {
  it("records both an execution outcome and a contract outcome", async () => {
    const dir = await workspace();
    await runFlow(workflow(0.95), dir, { simulate: true });
    const state = await loadFlowState(dir);
    expect(state?.units.repair.executionOutcome).toBe("completed");
    expect(state?.units.repair.contractOutcome).toBeDefined();
  });

  it("marks a unit with no objective as not_applicable rather than succeeded", async () => {
    const dir = await workspace();
    const wf = WorkflowDef.parse({
      ir_version: 2,
      stages: [{ id: "plain", owner: "x", runtime: "dry-run", outputs: ["out.md"] }],
    });
    await runFlow(wf, dir, { simulate: true });
    const state = await loadFlowState(dir);
    expect(state?.units.plain.contractOutcome).toBe("not_applicable");
  });

  it("blocks the workspace when a protected metric falls", async () => {
    const dir = await workspace();
    await runFlow(workflow(0.95), dir, { simulate: true, seedObservations: { test_coverage: 0.5, row_validity: 1 } });
    // A second run whose measurement reports row_validity below target must
    // block rather than continue to the next round.
    const state = await loadFlowState(dir);
    expect(state?.blocks).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contract-engine-cycle`
Expected: FAIL — `executionOutcome` and `contractOutcome` are not on `UnitState`.

- [ ] **Step 3: Write minimal implementation**

Add to `UnitState` in `src/lib/workflow/state.ts`:

```ts
  executionOutcome: ExecutionOutcome.optional(),
  contractOutcome: ContractOutcome.optional(),
  objectiveProgress: z.record(ObjectiveProgress).default({}),
```

In `src/lib/workflow/engine.ts`, around each unit execution:

1. Before dispatch: `assertRunnable(state)`; compute `idempotencyKey`; `journalAttempt` in `prepared`; `inventoryWorkspace` into `before`; `snapshotValues` into `beforeMetrics`.
2. Dispatch: journal `dispatched`, hold a lease, renew on each progress event.
3. After: journal `applied`; `inventoryWorkspace` into `after`; run `enforceEffects` — a non-null result short-circuits to that contract outcome.
4. Run `evaluate_with` measurement units; `snapshotValues` into `afterMetrics`.
5. `evaluateContract({ ... })` → contract outcome; `recordAttempt` into `objectiveProgress`.
6. Apply `executionAction` then `contractAction`; `raiseBlock` when `blocksWorkspace`.
7. Journal `committed`.

Delete the code path that infers success from changed declared outputs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contract-engine-cycle`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole suite and repair fallout**

Run: `npm run build && npm test`
Expected: existing engine tests that assert on "succeeded" need updating to the two-axis model. Update the assertions to the correct new outcome; never re-add the output-changed inference to keep an old test green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/engine.ts src/lib/workflow/state.ts tests/
git commit -m "feat!: replace output-changed success inference with the typed contract cycle"
```

---

### Task 14: Domain-neutral fault fixtures and documentation

**Files:**
- Create: `tests/contract-fault-matrix.test.ts`
- Modify: `docs/workflow-ir.md` (IR v2 section)
- Modify: `README.md` (contract concepts)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing test**

Create `tests/contract-fault-matrix.test.ts` covering the six spec fixtures, all domain-neutral:

```ts
import { describe, it, expect } from "vitest";
import { evaluateContract } from "../src/lib/workflow/acceptance.js";
import { objectiveKey, strategyFingerprint, recordAttempt, isRepeatedStrategy } from "../src/lib/workflow/stagnation.js";
import { classifyHealth } from "../src/lib/workflow/leases.js";
import { executionAction } from "../src/lib/workflow/outcomes.js";

const coverage = { metric: "test_coverage", operator: "at_least" as const, target: 0.9 };
const rows = { metric: "row_validity", operator: "at_least" as const, target: 1 };
const improve = { metric: "test_coverage", min_absolute_delta: 0.01, min_gap_fraction: 0.2, max_attempts: 2 };

describe("domain-neutral fault matrix", () => {
  it("a code repair that reaches the coverage target is accepted", () => {
    expect(evaluateContract({
      acceptance: [coverage], must_improve: [improve], must_preserve: [],
      before: { test_coverage: 0.5 }, after: { test_coverage: 0.95 }, attempts: 1, pending: [],
    })).toBe("accepted");
  });

  it("a document repair short of target is improved, not accepted", () => {
    expect(evaluateContract({
      acceptance: [{ metric: "doc_score", operator: "at_least", target: 8 }],
      must_improve: [{ metric: "doc_score", min_absolute_delta: 0.1, min_gap_fraction: 0.2, max_attempts: 3 }],
      must_preserve: [], before: { doc_score: 5 }, after: { doc_score: 6.5 }, attempts: 1, pending: [],
    })).toBe("improved");
  });

  it("a data transformation that regresses row validity blocks", () => {
    expect(evaluateContract({
      acceptance: [coverage], must_improve: [improve], must_preserve: [rows],
      before: { test_coverage: 0.5, row_validity: 1 },
      after: { test_coverage: 0.5, row_validity: 0.7 }, attempts: 1, pending: [],
    })).toBe("regressed");
  });

  it("a repeated strategy against an unchanged objective is rejected", () => {
    const key = objectiveKey(coverage, [], ["src/a.ts"]);
    const fingerprint = strategyFingerprint(key, "repair_module", "rewrite_tests");
    const { state } = recordAttempt({}, key, fingerprint, "unmet", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, fingerprint)).toBe(true);
  });

  it("a deferred expensive measurement yields pending_verification, not acceptance", () => {
    expect(evaluateContract({
      acceptance: [coverage], must_improve: [improve], must_preserve: [],
      before: { test_coverage: 0.5 }, after: { test_coverage: 0.99 },
      attempts: 1, pending: ["test_coverage"],
    })).toBe("pending_verification");
  });

  it("a quota interruption resumes from checkpoint and is not a failed strategy", () => {
    expect(executionAction("quota_exhausted")).toBe("pause_and_resume_from_checkpoint");
    const key = objectiveKey(coverage, [], []);
    const fingerprint = strategyFingerprint(key, "repair_module", "rewrite_tests");
    const { state } = recordAttempt({}, key, fingerprint, "not_applicable", 0.5, 0.5);
    expect(isRepeatedStrategy(state, key, fingerprint)).toBe(false);
  });

  it("an attempt running a long time with progress is never worker_lost", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const lease = {
      lease_owner: "w", lease_expires_at: new Date(now + 60_000).toISOString(),
      last_progress_sequence: 5, last_progress_at: new Date(now - 1_000).toISOString(),
      renewals_without_progress: 0,
    };
    const attempt = {
      invocation_id: "i", idempotency_key: "k", unit_key: "u",
      attempt_state: "dispatched" as const, intended_effects: [], applied_effects: [], sequence: 1,
    };
    expect(classifyHealth(lease, attempt, now, { stalled_renewals: 3, stalled_ms: 600_000 }))
      .toBe("running_progressing");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- contract-fault-matrix`
Expected: PASS, 7 tests — these compose modules already built, so they should pass immediately. If any fails, the defect is in the composed module, not in the fixture.

- [ ] **Step 3: Confirm no domain vocabulary leaked into the kernel**

Run:
```bash
grep -rniE 'citation|manuscript|chapter|landmark|scholarly|bibliograph|figure_spec' src/ && echo "DOMAIN LEAK" || echo "clean"
```
Expected: `clean`. Any hit is a Plan 3 concern that has landed in the wrong repository.

- [ ] **Step 4: Document IR v2**

Add to `docs/workflow-ir.md` a section stating: `ir_version: 2` is required; v1 manifests are rejected with a migration message; work units gain `kind`, `reads`, `owns`, `writes_observations`, `evaluate_with`, `acceptance`, `must_improve`, `must_preserve`, `strategy`; success is no longer inferred from changed outputs; and the recovery-action table gains a row — *Adopt IR v2 → `reset`, because existing unit records are reinterpreted under new semantics.*

- [ ] **Step 5: Full verification**

Run:
```bash
npm run build && npm test && npm run schema:export && npm test -- manifest-schema-export
cd dashboard && npm install && npm run build && npm test
git diff --check
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/contract-fault-matrix.test.ts docs/workflow-ir.md README.md
git commit -m "test(workflow): add domain-neutral contract fault matrix and document IR v2"
```

---

## Plan Self-Review

**Spec coverage.** §B1 execution roles → Task 2. §B2 effects semantics → Tasks 2, 6. §B3 acceptance, progress, invariants → Task 5. §B4 measurement scheduling → Task 13 (the engine runs `evaluate_with`; the tier/invalidation registry itself is Plan 1's). §B5 two-axis outcomes → Task 1. §B6 fingerprints and per-objective stagnation → Task 7. §B7 transitions → Task 1 policies, applied in Task 13. §B8 removals → Task 3 (ir_version), Task 13 (output-changed inference). §B9 reachability → **not in this plan**: the analysis is MrMaLiang's and the kernel consumes its verdict; wiring lands in Plan 3. §B10 blocked workspace → Task 12. §B11 observation store → Task 4. §B12 cost accounting → **deferred**: it needs the `estimated_cost` values from Plan 1's registry, so it lands in Plan 3 with the compiler. §B13 attempt lifecycle → Task 8. §B14 checkpoint contract → partially Task 8; full checkpoint contents extend the existing `checkpoint-index.ts` in Task 13. §B15 leases → Task 9. §B16 concurrency → Task 10. §B17 pinning → Task 11. §B18 untrusted content → **Plan 3**, because the task packet that carries labeled untrusted content is built by MrMaLiang.

**Type consistency.** `ContractOutcome` (Task 1) is the return type of `evaluateContract` (Task 5), `enforceEffects` (Task 6), and the parameter of `recordAttempt` (Task 7) and `raiseBlock` (Task 12). `Criterion` and `MustImprove` (Task 5) are imported into `schema.ts` in the same task and into `stagnation.ts` in Task 7. `matchesEnvelope` is exported from `schema.ts` in Task 2 and consumed by `effects.ts` (Task 6) and `conflicts.ts` (Task 10). `AttemptRecord` (Task 8) is the parameter of `classifyHealth` (Task 9). `workflowHash` (existing, `state.ts`) is consumed by `pinning.ts` (Task 11). `Observation` appears in both repositories with the same field set by design — the kernel's copy in Task 4 is the authority for the on-disk format, and Plan 1's mirrors it.

**Known ordering constraint.** Task 2 must land before Tasks 6 and 10, which import `matchesEnvelope` from `schema.ts`. Task 5 must land before Task 7.

---

## Pending Amendments

Blocking. This plan needs reorganization, not patching.

1. **`writes` is never added to the schema.** Task 2 adds `kind`, `reads`,
   `owns`, `writes_observations` and `evaluate_with`, but every test and example
   uses `writes`. Choose one canonical field — `writes` for expected changes,
   `outputs` retaining artifact-contract meaning — and add it.
2. **`ir_version` must not default to 2.** An unversioned v1 manifest would be
   silently reinterpreted, defeating Task 3's explicit rejection. Require it.
3. **Undeclared reads are not enforceable by hashing.** Task 6 cannot observe
   what a worker read, and an empty `owns` bypasses enforcement entirely.
   Replace post-hoc live-workspace hashing with a transactional task workspace:
   construct it from declared `reads`, run the worker there, validate its diff,
   then commit declared changes to the canonical workspace.
4. **Delete the second acceptance implementation.** Plan 2's version uses exact
   float equality, treats `equals` as one-sided, does not require protected
   measurements to exist, and does not validate operator against direction. The
   kernel owns the arithmetic in wire contract §6, consuming compiled criteria
   that carry `tolerance`, `direction` and `scope_key`.
5. **Attempts, leases and checkpoints are schemas, not mechanisms.** Needed:
   an append-only transition journal rather than one overwritten file per
   invocation; an idempotency key that is actually claimed, looked up and passed
   to the provider; atomic lease acquire/renew/release that rejects a different
   owner; the full §B14 checkpoint contents; and the complete `RunPin` in run
   state, not only its digest.
6. **`WorkerRuntime` has no progress or checkpoint event stream** (see
   `src/lib/workflow/runtimes/base.ts`), so a lease cannot be renewed. The
   `WorkerEvent` protocol needs its own implementation task before leases.
7. **Concurrency contradicts the spec.** The conflict graph compares `owns`
   against `owns` only, and lets a measurement read a workspace a mutation is
   changing, with no snapshot. Until snapshots exist, read/write overlaps must
   serialize. Add `snapshot_id`, snapshot-bound joins, and declared merge
   reducers.
8. **`repair-block` is registered but never implemented.** Add a task covering
   corrective-subflow materialization, authorization, re-measurement, block
   clearing, interruption, and failure. A block must not clear merely because
   the corrective action returned.
9. **Task 13's engine test cannot compile.** `runFlow` takes a single
   `RunFlowOptions`; `simulate` and `seedObservations` do not exist, and the
   script measurement writes to an unset `process.env.OUT`. Split it into tests
   for standard stages, loops, foreach, action dispatch, remote jobs,
   interruption and resume, measurement failure, and block repair.
10. **`stop-condition.ts` still hardcodes `reports/metrics.json`.** The plan
    claims that path is removed but never replaces the reader.
11. **The domain-neutrality grep is a manual command** that also matches
    existing domain-flavored examples. Replace it with an automated
    dependency-boundary test plus a small reviewed allowlist.

Reorganize into kernel milestones: IR v2 schema and migration; transactional
task workspace and effect commit; engine-owned observation ingestion; scoped
acceptance and invariants; the `WorkerEvent` protocol; append-only attempt
journal and idempotency claims; persistent leases and orphan recovery;
snapshot, conflict and join scheduling; blocked corrective subflows; run pin
storage and migration; integration across every scheduler shape.
