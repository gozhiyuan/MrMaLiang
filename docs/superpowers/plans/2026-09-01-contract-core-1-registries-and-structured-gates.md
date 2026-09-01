# Contract Core, Plan 1: Registries and Structured Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MrMaLiang's deterministic gates emit structured findings and numeric observations instead of prose, behind closed registries that a fail-closed router and a CI coverage test enforce.

**Architecture:** Gates currently compute both the routing triple (artifact, kind, effect) and the numeric observation (value, target), then flatten both into `string` and discard them. This plan adds a `src/lib/registry/` module holding branded ID types, the gate-class table, the routing table, the metric registry with measurement pipelines, and an observation store; then converts the gate producers to emit those records. No MalaClaw change and no workflow-topology change — this is the foundation both later plans consume.

**Tech Stack:** TypeScript (ESM, Node 22+), Zod 3 for strict schemas, Vitest 4 for tests, existing `longwrite` Commander CLI.

**Spec:** `docs/superpowers/specs/2026-08-31-contract-enforcement-core-design.md` (§A1–A4, §A9, §B4)

## Global Constraints

- Node.js 22 or newer. All source is ESM; **relative imports must carry the `.js` extension** even in `.ts` files.
- Zod schemas are `.strict()`. Validate at trust boundaries; never widen a schema to make bad input pass.
- Registries are the single source of truth. Never restate registry content in a prompt string — Plan 3 renders prompts from these registries. Adding a policy in two places is the defect this plan removes.
- Routing fails closed. There is no default route; an unresolved triple is an error, never a fallback.
- Never order or compare observations by wall-clock time. Freshness resolves by digest and monotonic sequence (Spec 1 §B11).
- MalaClaw gains nothing in this plan. If a change seems to require a MalaClaw edit, stop — it belongs in Plan 2.
- Tests run with `npm test --workspace @mr-maliang/longwrite`. Workspace fixtures use `fs.mkdtemp` under `os.tmpdir()` and are removed in `afterEach`, following `tests/corpus-gates.test.ts`.
- Preserve the dirty worktree. Only touch files named in a task.

---

### Task 1: Branded ID types and closed vocabularies

Establishes the type separation that makes the live `rendered_visual_review` bug (a metric string accepted where a gate id was expected) a compile error.

**Files:**
- Create: `packages/longwrite/src/lib/registry/ids.ts`
- Test: `packages/longwrite/tests/registry-ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: types `GateId`, `MetricId`, `CapabilityId`; const arrays `ARTIFACT_KINDS`, `REQUIRED_EFFECTS`, `GATE_CLASSES`; types `ArtifactKind`, `RequiredEffect`, `GateClass`; constructors `gateId(s: string): GateId`, `metricId(s: string): MetricId`, `capabilityId(s: string): CapabilityId`; Zod schemas `GateIdSchema`, `MetricIdSchema`, `ArtifactKindSchema`, `RequiredEffectSchema`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KINDS,
  REQUIRED_EFFECTS,
  GATE_CLASSES,
  ArtifactKindSchema,
  RequiredEffectSchema,
  GateIdSchema,
  gateId,
  metricId,
} from "../src/lib/registry/ids.js";

describe("registry ids", () => {
  it("exposes the closed artifact-kind vocabulary", () => {
    expect(ARTIFACT_KINDS).toContain("chapter_prose");
    expect(ARTIFACT_KINDS).toContain("latex_layout");
    expect(ARTIFACT_KINDS).toContain("experiment_manifest");
    expect(new Set(ARTIFACT_KINDS).size).toBe(ARTIFACT_KINDS.length);
  });

  it("exposes the closed required-effect vocabulary", () => {
    expect(REQUIRED_EFFECTS).toContain("add_explicit_artifact_reference");
    expect(REQUIRED_EFFECTS).toContain("repair_bibliography_consistency");
    expect(new Set(REQUIRED_EFFECTS).size).toBe(REQUIRED_EFFECTS.length);
  });

  it("exposes the three gate classes", () => {
    expect([...GATE_CLASSES].sort()).toEqual(["environment", "manuscript", "measurement"]);
  });

  it("rejects a value outside a closed vocabulary", () => {
    expect(ArtifactKindSchema.safeParse("chapter_prose").success).toBe(true);
    expect(ArtifactKindSchema.safeParse("prose").success).toBe(false);
    expect(RequiredEffectSchema.safeParse("make_it_better").success).toBe(false);
  });

  it("rejects a malformed identifier", () => {
    expect(GateIdSchema.safeParse("figure_references").success).toBe(true);
    expect(GateIdSchema.safeParse("Figure References").success).toBe(false);
    expect(() => gateId("Figure References")).toThrow();
  });

  it("keeps gate and metric ids from being interchanged at runtime", () => {
    const gate = gateId("rendered_visual_review");
    const metric = metricId("rendered_visual_review");
    // Same text, different brands: equality of the underlying string is fine,
    // but the type system must not let one be passed where the other is due.
    expect(String(gate)).toBe(String(metric));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-ids`
Expected: FAIL — `Failed to resolve import "../src/lib/registry/ids.js"`

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/ids.ts`:

```ts
import { z } from "zod";

/** Identifier shape shared by every registry key. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/** Branded ids. A metric-shaped string reaching a GateId parameter is the bug
 * that made `repairRouteForGate("rendered_visual_review")` steer live
 * acceptance selection; separate brands make that a compile error. */
declare const gateBrand: unique symbol;
declare const metricBrand: unique symbol;
declare const capabilityBrand: unique symbol;

export type GateId = string & { readonly [gateBrand]: true };
export type MetricId = string & { readonly [metricBrand]: true };
export type CapabilityId = string & { readonly [capabilityBrand]: true };

export const GateIdSchema = z.string().regex(IDENTIFIER).transform((value) => value as GateId);
export const MetricIdSchema = z.string().regex(IDENTIFIER).transform((value) => value as MetricId);
export const CapabilityIdSchema = z.string().regex(IDENTIFIER).transform((value) => value as CapabilityId);

export function gateId(value: string): GateId {
  return GateIdSchema.parse(value);
}
export function metricId(value: string): MetricId {
  return MetricIdSchema.parse(value);
}
export function capabilityId(value: string): CapabilityId {
  return CapabilityIdSchema.parse(value);
}

/** Whether a gate is repairable at all. Only `manuscript` routes to a
 * capability: an `environment` gate is a precondition of the run (a missing
 * LaTeX compiler is not repaired by editing prose), and a `measurement` gate
 * is re-run rather than repaired. */
export const GATE_CLASSES = ["manuscript", "environment", "measurement"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];
export const GateClassSchema = z.enum(GATE_CLASSES);

/** What kind of thing a finding is about. The path alone is insufficient:
 * `paper/sections/03.tex` is generated from `chapters/section-03.md`, and only
 * one of them is editable by a repair. */
export const ARTIFACT_KINDS = [
  "chapter_prose",
  "abstract",
  "outline",
  "figure_spec",
  "table_spec",
  "latex_layout",
  "bibliography",
  "source_record",
  "evidence_packet",
  "corpus",
  "experiment_manifest",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

/** What must change. Deliberately small; a new value is a registry change with
 * a test, never a prompt edit. */
export const REQUIRED_EFFECTS = [
  "add_explicit_artifact_reference",
  "add_supporting_citation",
  "remove_unsupported_claim",
  "repair_citation_marker",
  "replace_organizing_claim",
  "resolve_contradiction",
  "remove_redundant_prose",
  "repair_artifact_content",
  "repair_artifact_placement",
  "acquire_additional_evidence",
  "upgrade_source_quality",
  "repair_source_metadata",
  "repair_bibliography_consistency",
] as const;
export type RequiredEffect = (typeof REQUIRED_EFFECTS)[number];
export const RequiredEffectSchema = z.enum(REQUIRED_EFFECTS);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-ids`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/ids.ts packages/longwrite/tests/registry-ids.test.ts
git commit -m "feat(registry): add branded ids and closed artifact/effect vocabularies"
```

---

### Task 2: Gate class table

**Files:**
- Create: `packages/longwrite/src/lib/registry/gate-classes.ts`
- Test: `packages/longwrite/tests/registry-gate-classes.test.ts`

**Interfaces:**
- Consumes: `GateId`, `GateClass`, `gateId` from Task 1.
- Produces: `GATE_CLASS_TABLE: ReadonlyMap<GateId, GateClass>`; `gateClass(id: GateId): GateClass` which **throws** on an unclassified gate; `classifiedGateIds(): GateId[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-gate-classes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gateId } from "../src/lib/registry/ids.js";
import { gateClass, classifiedGateIds } from "../src/lib/registry/gate-classes.js";

describe("gate classes", () => {
  it("classifies a manuscript defect gate", () => {
    expect(gateClass(gateId("figure_references"))).toBe("manuscript");
    expect(gateClass(gateId("core_sources"))).toBe("manuscript");
  });

  it("classifies preflight preconditions as environment", () => {
    expect(gateClass(gateId("pdf_compiler"))).toBe("environment");
    expect(gateClass(gateId("worker_runtime"))).toBe("environment");
    expect(gateClass(gateId("token_guardrail"))).toBe("environment");
  });

  it("classifies re-runnable checks as measurement", () => {
    expect(gateClass(gateId("full_claim_double_review"))).toBe("measurement");
  });

  it("throws rather than defaulting for an unknown gate", () => {
    expect(() => gateClass(gateId("some_new_gate"))).toThrow(/unclassified gate/);
  });

  it("lists every classified gate", () => {
    expect(classifiedGateIds().length).toBeGreaterThan(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-gate-classes`
Expected: FAIL — cannot resolve `gate-classes.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/gate-classes.ts`. Populate `manuscript` with every gate id emitted by `validation/research.ts`, `validation/figures.ts`, `validation/latex.ts`, `validation/longform.ts`, `research/corpus-gates.ts`, `research/survey-contract.ts`, `ops/visual-review.ts`, and `publication.ts` — except the two `measurement` entries below. Populate `environment` with every gate id emitted by `commands/preflight.ts`.

```ts
import { gateId, type GateClass, type GateId } from "./ids.js";

/** Preconditions of the run, not defects in the manuscript. Routing these to a
 * repair capability is a category error: today they land on `revise_sections`
 * by default, which nominally repairs a missing LaTeX compiler by editing
 * prose. */
const ENVIRONMENT = [
  "article_front_matter", "direct_llm_drafting", "draft_concurrency", "pdf_compiler",
  "public_release_urls", "publication_figure_renderer", "rendered_visual_review_tools",
  "rendered_visual_review_topology", "review_topology", "token_guardrail", "worker_runtime",
];

/** Things to re-run, never to repair. */
const MEASUREMENT = ["full_claim_double_review", "review_no_regressions"];

/** Defects in the artifact under construction. Every one of these must have a
 * route (enforced by tests/routing-coverage.test.ts). */
const MANUSCRIPT = [
  "bibliography_consistent", "chapter_outline_identity", "citation_evidence_ledger",
  "citation_markers_present", "citation_url_liveness", "citation_verification",
  "cited_literature_release_gates", "claim_contradictions", "claim_support",
  "codebase_evidence", "core_sources", "diagram_connectivity", "empirical_experiment",
  "evidence_coverage", "figure_artifacts", "figure_manifest", "figure_references",
  "freshness", "full_mode_visual_contract", "full_research_contracts",
  "full_source_identity", "introduction_gap_contributions", "landmark_citation_coverage",
  "landmark_coverage", "latex_build", "latex_outline_structure", "latex_sources",
  "limitations_future_work", "literature_quality_score", "manuscript_build",
  "method_family_chapters", "multi_axis_taxonomy", "prose_redundancy",
  "publication_article_layout", "publication_artifact_contract", "publication_custom_template",
  "publication_figures", "publication_latex", "publication_layout", "publication_min_pages",
  "publication_page_limit", "publication_release_gates", "publication_required_sections",
  "reader_facing_publication", "related_work_differentiation", "related_work_matrix",
  "rendered_visual_review", "research_artifacts_present", "research_policy",
  "review_target", "section_evidence_requirements", "source_coverage",
  "source_type_diversity", "style_drift", "target_length", "taxonomy_direct_evidence",
  "total_candidates", "visual_review_contract",
];

function build(): ReadonlyMap<GateId, GateClass> {
  const table = new Map<GateId, GateClass>();
  for (const id of MANUSCRIPT) table.set(gateId(id), "manuscript");
  for (const id of ENVIRONMENT) table.set(gateId(id), "environment");
  for (const id of MEASUREMENT) table.set(gateId(id), "measurement");
  return table;
}

export const GATE_CLASS_TABLE = build();

/** Fails closed. An unclassified gate is a registry omission, and returning a
 * default here is exactly how 45 gates came to route to a prose editor. */
export function gateClass(id: GateId): GateClass {
  const found = GATE_CLASS_TABLE.get(id);
  if (!found) throw new Error(`unclassified gate: ${id}. Add it to src/lib/registry/gate-classes.ts.`);
  return found;
}

export function classifiedGateIds(): GateId[] {
  return [...GATE_CLASS_TABLE.keys()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-gate-classes`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/gate-classes.ts packages/longwrite/tests/registry-gate-classes.test.ts
git commit -m "feat(registry): classify gates as manuscript, environment, or measurement"
```

---

### Task 3: Fail-closed routing table

**Files:**
- Create: `packages/longwrite/src/lib/registry/routing.ts`
- Test: `packages/longwrite/tests/registry-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 ids and vocabularies; `gateClass` from Task 2.
- Produces: type `RouteKey = { gate: GateId; kind: ArtifactKind; effect: RequiredEffect }`; `resolveCapability(key: RouteKey): CapabilityId` which **throws** `UnroutedFindingError` when no entry matches; class `UnroutedFindingError extends Error` carrying `key`; `ROUTES: readonly RouteEntry[]`; `routedGateIds(): Set<GateId>`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gateId } from "../src/lib/registry/ids.js";
import { resolveCapability, UnroutedFindingError, routedGateIds } from "../src/lib/registry/routing.js";

describe("fail-closed routing", () => {
  it("routes a prose-reference defect on a visual gate to the section editor", () => {
    const capability = resolveCapability({
      gate: gateId("rendered_visual_review"),
      kind: "chapter_prose",
      effect: "add_explicit_artifact_reference",
    });
    expect(String(capability)).toBe("revise_sections");
  });

  it("routes a figure-content defect on the same gate to the visual planner", () => {
    const capability = resolveCapability({
      gate: gateId("rendered_visual_review"),
      kind: "figure_spec",
      effect: "repair_artifact_content",
    });
    expect(String(capability)).toBe("revise_visual_plan");
  });

  it("routes a retrieval gate to research expansion, never to prose", () => {
    const capability = resolveCapability({
      gate: gateId("core_sources"),
      kind: "corpus",
      effect: "acquire_additional_evidence",
    });
    expect(String(capability)).toBe("targeted_research_expansion");
  });

  it("throws instead of defaulting when the triple is unrouted", () => {
    expect(() => resolveCapability({
      gate: gateId("core_sources"),
      kind: "chapter_prose",
      effect: "remove_redundant_prose",
    })).toThrow(UnroutedFindingError);
  });

  it("carries the unresolved key on the error for the diagnosis unit", () => {
    try {
      resolveCapability({ gate: gateId("style_drift"), kind: "corpus", effect: "upgrade_source_quality" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnroutedFindingError);
      expect((error as UnroutedFindingError).key.kind).toBe("corpus");
    }
  });

  it("never routes an environment gate", () => {
    expect(routedGateIds().has(gateId("pdf_compiler"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-routing`
Expected: FAIL — cannot resolve `routing.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/routing.ts`. Add one `RouteEntry` per legal `(gate, kind, effect)` combination for every `manuscript` gate; the entries below are the exact shape, and every remaining manuscript gate is added the same way with the artifact kind it actually owns.

```ts
import { capabilityId, gateId, type ArtifactKind, type CapabilityId, type GateId, type RequiredEffect } from "./ids.js";

export type RouteKey = { gate: GateId; kind: ArtifactKind; effect: RequiredEffect };
export type RouteEntry = RouteKey & { capability: CapabilityId };

export class UnroutedFindingError extends Error {
  constructor(readonly key: RouteKey) {
    super(`no capability owns (${key.gate}, ${key.kind}, ${key.effect}); add a route or reclassify the gate`);
    this.name = "UnroutedFindingError";
  }
}

function route(gate: string, kind: ArtifactKind, effect: RequiredEffect, capability: string): RouteEntry {
  return { gate: gateId(gate), kind, effect, capability: capabilityId(capability) };
}

export const ROUTES: readonly RouteEntry[] = [
  // One gate, several owners — the case gate-keyed routing could not express.
  route("rendered_visual_review", "chapter_prose", "add_explicit_artifact_reference", "revise_sections"),
  route("rendered_visual_review", "figure_spec", "repair_artifact_content", "revise_visual_plan"),
  route("rendered_visual_review", "figure_spec", "repair_artifact_placement", "revise_visual_plan"),
  route("rendered_visual_review", "latex_layout", "repair_artifact_placement", "revise_visual_plan"),

  // Retrieval gates. These must never reach a prose editor.
  route("core_sources", "corpus", "acquire_additional_evidence", "targeted_research_expansion"),
  route("total_candidates", "corpus", "acquire_additional_evidence", "targeted_research_expansion"),
  route("freshness", "corpus", "acquire_additional_evidence", "targeted_research_expansion"),
  route("source_type_diversity", "corpus", "acquire_additional_evidence", "targeted_research_expansion"),
  route("landmark_coverage", "corpus", "acquire_additional_evidence", "targeted_research_expansion"),
  route("literature_quality_score", "corpus", "upgrade_source_quality", "targeted_research_expansion"),

  // Source-record repairs, which nothing owned before.
  route("citation_url_liveness", "source_record", "repair_source_metadata", "repair_source_metadata"),
  route("full_source_identity", "source_record", "repair_source_metadata", "repair_source_metadata"),
  route("bibliography_consistent", "bibliography", "repair_bibliography_consistency", "repair_bibliography"),

  // Prose repairs.
  route("landmark_citation_coverage", "chapter_prose", "add_supporting_citation", "revise_sections"),
  route("claim_contradictions", "chapter_prose", "resolve_contradiction", "revise_sections"),
  route("prose_redundancy", "chapter_prose", "remove_redundant_prose", "revise_sections"),
  route("citation_markers_present", "chapter_prose", "repair_citation_marker", "revise_sections"),
  route("citation_evidence_ledger", "chapter_prose", "repair_citation_marker", "revise_sections"),
  route("claim_support", "chapter_prose", "remove_unsupported_claim", "revise_sections"),
  route("target_length", "chapter_prose", "remove_redundant_prose", "revise_sections"),
  route("style_drift", "chapter_prose", "remove_redundant_prose", "revise_sections"),

  // Structural defects from the survey contract.
  route("multi_axis_taxonomy", "outline", "replace_organizing_claim", "reopen_outline"),
  route("related_work_matrix", "outline", "replace_organizing_claim", "reopen_outline"),
  route("method_family_chapters", "outline", "replace_organizing_claim", "reopen_outline"),
  route("section_evidence_requirements", "outline", "replace_organizing_claim", "reopen_outline"),

  // Figure and table artifacts.
  route("figure_references", "figure_spec", "repair_artifact_placement", "revise_visual_plan"),
  route("figure_manifest", "figure_spec", "repair_artifact_content", "revise_visual_plan"),
  route("figure_artifacts", "figure_spec", "repair_artifact_content", "revise_visual_plan"),
  route("diagram_connectivity", "figure_spec", "repair_artifact_content", "revise_visual_plan"),
  route("publication_layout", "latex_layout", "repair_artifact_placement", "revise_visual_plan"),

  // Out of LongWrite's reach entirely.
  route("empirical_experiment", "experiment_manifest", "acquire_additional_evidence", "request_operator_clarification"),
];

const INDEX = new Map<string, CapabilityId>(
  ROUTES.map((entry) => [`${entry.gate}\u0000${entry.kind}\u0000${entry.effect}`, entry.capability]),
);

/** No default. An unresolved triple escalates to diagnosis (Plan 3), which is
 * the whole point: a gate added later cannot silently land on prose revision. */
export function resolveCapability(key: RouteKey): CapabilityId {
  const found = INDEX.get(`${key.gate}\u0000${key.kind}\u0000${key.effect}`);
  if (!found) throw new UnroutedFindingError(key);
  return found;
}

export function routedGateIds(): Set<GateId> {
  return new Set(ROUTES.map((entry) => entry.gate));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-routing`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/routing.ts packages/longwrite/tests/registry-routing.test.ts
git commit -m "feat(registry): route findings on gate + artifact kind + required effect, fail closed"
```

---

### Task 4: Generated routing-coverage test

The inventory that produced this design was hand-maintained and wrong twice. This task makes it generated and CI-enforced.

**Files:**
- Create: `packages/longwrite/src/lib/registry/gate-inventory.ts`
- Create: `packages/longwrite/tests/routing-coverage.test.ts`
- Test: the second file is itself the test.

**Interfaces:**
- Consumes: `classifiedGateIds`, `gateClass` (Task 2); `routedGateIds` (Task 3).
- Produces: `scanEmittedGateIds(srcDir: string): Promise<Set<string>>` — scans TypeScript sources for object literals carrying both an `id: "…"` and a `pass:` field, returning every emitted gate id.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/routing-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanEmittedGateIds } from "../src/lib/registry/gate-inventory.js";
import { gateClass, GATE_CLASS_TABLE } from "../src/lib/registry/gate-classes.js";
import { routedGateIds } from "../src/lib/registry/routing.js";
import { gateId } from "../src/lib/registry/ids.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("routing coverage", () => {
  it("classifies every gate id any producer emits", async () => {
    const emitted = await scanEmittedGateIds(SRC);
    const unclassified = [...emitted].filter((id) => !GATE_CLASS_TABLE.has(gateId(id))).sort();
    expect(unclassified, `unclassified gates: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("routes every manuscript-class gate", async () => {
    const emitted = await scanEmittedGateIds(SRC);
    const routed = routedGateIds();
    const unrouted = [...emitted]
      .filter((id) => GATE_CLASS_TABLE.has(gateId(id)) && gateClass(gateId(id)) === "manuscript")
      .filter((id) => !routed.has(gateId(id)))
      .sort();
    expect(unrouted, `manuscript gates with no route: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("never routes an environment or measurement gate", async () => {
    const routed = [...routedGateIds()];
    const misrouted = routed.filter((id) => gateClass(id) !== "manuscript").map(String).sort();
    expect(misrouted, `non-manuscript gates with a route: ${misrouted.join(", ")}`).toEqual([]);
  });

  it("has no route for a gate no producer emits", async () => {
    const emitted = await scanEmittedGateIds(SRC);
    const stale = [...routedGateIds()].map(String).filter((id) => !emitted.has(id)).sort();
    expect(stale, `routes with no producer: ${stale.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: FAIL — cannot resolve `gate-inventory.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/gate-inventory.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";

const ID_LITERAL = /id:\s*"([a-z][a-z0-9_]*)"/g;
/** How far from an `id:` a `pass:` may sit and still belong to the same object
 * literal. Gate records in this codebase are small; 220 characters covers the
 * longest of them without reaching into a neighbouring literal. */
const WINDOW = 220;

async function typescriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await typescriptFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Every gate id emitted anywhere in the source tree.
 *
 * Deliberately a scan rather than a hand-maintained list: the inventory behind
 * this design was written by hand and was wrong twice, once by missing four
 * producers entirely. A generated set cannot drift from the code. */
export async function scanEmittedGateIds(srcDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of await typescriptFiles(srcDir)) {
    if (file.includes(`${path.sep}registry${path.sep}`)) continue; // the registry declares, it does not emit
    const source = await fs.readFile(file, "utf-8");
    for (const match of source.matchAll(ID_LITERAL)) {
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + WINDOW);
      const before = source.slice(Math.max(0, match.index - WINDOW), match.index);
      if (/\bpass:/.test(after) || /\bpass:/.test(before)) ids.add(match[1]);
    }
  }
  return ids;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: PASS, 4 tests. If any test fails, the failure message names the exact gate ids to add to Task 2's tables or Task 3's `ROUTES` — fix the registry, never the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/gate-inventory.ts packages/longwrite/tests/routing-coverage.test.ts
git commit -m "test(registry): generate the gate inventory and enforce routing coverage in CI"
```

---

### Task 5: Structured finding and observation records

**Files:**
- Create: `packages/longwrite/src/lib/registry/records.ts`
- Test: `packages/longwrite/tests/registry-records.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces: Zod schemas `FindingSchema`, `ObservationSchema`, `StructuredCheckSchema`; types `Finding`, `Observation`, `StructuredCheck`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FindingSchema, ObservationSchema, StructuredCheckSchema } from "../src/lib/registry/records.js";

const finding = {
  id: "figure-1-missing-reference",
  gate_id: "rendered_visual_review",
  artifact: { kind: "chapter_prose", path: "chapters/section-03.md", artifact_id: "figure-1" },
  location: "paragraph preceding placement",
  required_effect: "add_explicit_artifact_reference",
  severity: "major",
  diagnostic: "Figure 1 is not named before its placement.",
};

const observation = {
  metric: "landmark_coverage_ratio",
  value: 0.083,
  target: 0.75,
  operator: "at_least",
  evaluator: "landmark_coverage",
  evaluator_digest: "a".repeat(64),
  input_digest: "b".repeat(64),
  sequence: 12,
  measured_at: "2026-09-01T00:00:00.000Z",
};

describe("structured records", () => {
  it("accepts a well-formed finding", () => {
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("rejects a finding whose effect is outside the vocabulary", () => {
    const bad = { ...finding, required_effect: "make_it_better" };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a finding with an unknown extra field", () => {
    const bad = { ...finding, hint: "try harder" };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a well-formed observation", () => {
    expect(ObservationSchema.safeParse(observation).success).toBe(true);
  });

  it("requires a sequence so freshness never resolves by clock", () => {
    const { sequence, ...withoutSequence } = observation;
    expect(ObservationSchema.safeParse(withoutSequence).success).toBe(false);
  });

  it("carries prose only as an unparsed diagnostic on the check", () => {
    const check = {
      id: "rendered_visual_review",
      pass: false,
      observations: [observation],
      findings: [finding],
      diagnostic: "1 of 12 landmark works are cited.",
    };
    expect(StructuredCheckSchema.safeParse(check).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-records`
Expected: FAIL — cannot resolve `records.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/records.ts`:

```ts
import { z } from "zod";
import { ArtifactKindSchema, GateIdSchema, MetricIdSchema, RequiredEffectSchema } from "./ids.js";

/** A defect, carrying everything the router needs. Emitted by the gate that
 * found it: the gate already holds the artifact and the effect, and flattening
 * them into a string is the information loss this replaces. */
export const FindingSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  gate_id: GateIdSchema,
  artifact: z.object({
    kind: ArtifactKindSchema,
    path: z.string().min(1),
    artifact_id: z.string().min(1).optional(),
  }).strict(),
  location: z.string().min(1).max(400).optional(),
  required_effect: RequiredEffectSchema,
  severity: z.enum(["minor", "major", "critical"]),
  /** For operators. Never parsed, never routed on. */
  diagnostic: z.string().min(1).max(8_000),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

/** One measured value with the provenance that makes it reusable. */
export const ObservationSchema = z.object({
  metric: MetricIdSchema,
  value: z.number().finite(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  evaluator: z.string().min(1),
  /** Implementation plus configuration version. A change invalidates reuse. */
  evaluator_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Declared reads, registry config, and for model pipelines the prompt and
   * model configuration. */
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Monotonic engine sequence. Freshness resolves on this, never on the clock:
   * under fan-out, clock order and causal order diverge. */
  sequence: z.number().int().nonnegative(),
  /** Provenance only. Never used for ordering. */
  measured_at: z.string().datetime(),
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const StructuredCheckSchema = z.object({
  id: GateIdSchema,
  pass: z.boolean(),
  observations: z.array(ObservationSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  diagnostic: z.string().max(8_000).optional(),
}).strict();
export type StructuredCheck = z.infer<typeof StructuredCheckSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-records`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/records.ts packages/longwrite/tests/registry-records.test.ts
git commit -m "feat(registry): add structured finding and observation records"
```

---

### Task 6: Metric registry with measurement pipelines

**Files:**
- Create: `packages/longwrite/src/lib/registry/metrics.ts`
- Test: `packages/longwrite/tests/registry-metrics.test.ts`

**Interfaces:**
- Consumes: Task 1 ids.
- Produces: type `MetricDefinition`; `METRIC_REGISTRY: ReadonlyMap<MetricId, MetricDefinition>`; `metricDefinition(id: MetricId): MetricDefinition` (throws on unknown); `metricsInvalidatedBy(changed: string[]): MetricId[]`.

`MetricDefinition` fields: `metric: MetricId`, `direction: "maximize" | "minimize"`, `target_type: "ratio" | "count" | "boolean" | "score"`, `measurement_tier: "unit" | "round" | "release"`, `measurement_kind: "script" | "model" | "external"`, `evaluator: string`, `producer?: string`, `validator?: string`, `reducer: string`, `requires: string[]`, `invalidated_by: string[]`, `estimated_cost: { model_calls: number; render_required: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import { METRIC_REGISTRY, metricDefinition, metricsInvalidatedBy } from "../src/lib/registry/metrics.js";

describe("metric registry", () => {
  it("defines every acceptance metric", () => {
    expect(METRIC_REGISTRY.size).toBe(22);
  });

  it("marks the three expensive metrics as release tier", () => {
    for (const id of ["rendered_visual_review", "review_score", "claim_support"]) {
      expect(metricDefinition(metricId(id)).measurement_tier).toBe("release");
    }
  });

  it("marks model-judged metrics with a producer, validator and reducer", () => {
    const review = metricDefinition(metricId("review_score"));
    expect(review.measurement_kind).toBe("model");
    expect(review.producer).toBe("persona_review");
    expect(review.validator).toBe("scorecard_schema");
    expect(review.reducer).toBe("deterministic_review_score");
  });

  it("keeps cheap metrics on the unit tier with no model cost", () => {
    const core = metricDefinition(metricId("core_sources"));
    expect(core.measurement_tier).toBe("unit");
    expect(core.measurement_kind).toBe("script");
    expect(core.estimated_cost.model_calls).toBe(0);
  });

  it("records direction so progress can be normalized by operator", () => {
    expect(metricDefinition(metricId("prose_redundancy")).direction).toBe("minimize");
    expect(metricDefinition(metricId("core_sources")).direction).toBe("maximize");
  });

  it("selects only the metrics a change invalidates", () => {
    const invalidated = metricsInvalidatedBy(["chapters/section-03.md"]).map(String);
    expect(invalidated).toContain("prose_redundancy");
    expect(invalidated).toContain("rendered_visual_review");
    expect(invalidated).not.toContain("core_sources");
  });

  it("throws rather than defaulting for an unknown metric", () => {
    expect(() => metricDefinition(metricId("invented_metric"))).toThrow(/unknown metric/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-metrics`
Expected: FAIL — cannot resolve `metrics.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/metrics.ts`. Define all 22 entries from `ACCEPTANCE_METRICS` in `src/lib/ops/action-plan.ts:7`. Use `claim_support` as the canonical name — the written key `claim_support_rate` is retired.

```ts
import { metricId, type MetricId } from "./ids.js";

export type MetricDefinition = {
  metric: MetricId;
  direction: "maximize" | "minimize";
  target_type: "ratio" | "count" | "boolean" | "score";
  measurement_tier: "unit" | "round" | "release";
  measurement_kind: "script" | "model" | "external";
  evaluator: string;
  /** Model pipelines only: what acquires the raw judgment. */
  producer?: string;
  /** Model pipelines only: what the raw judgment must satisfy. */
  validator?: string;
  /** Always present. An observation is trusted because acquisition, validation
   * and reduction are recorded — not because the whole measurement was
   * deterministic. */
  reducer: string;
  requires: string[];
  invalidated_by: string[];
  estimated_cost: { model_calls: number; render_required: boolean };
};

function script(
  metric: string,
  direction: MetricDefinition["direction"],
  target_type: MetricDefinition["target_type"],
  tier: MetricDefinition["measurement_tier"],
  requires: string[],
  invalidated_by: string[],
): MetricDefinition {
  return {
    metric: metricId(metric), direction, target_type,
    measurement_tier: tier, measurement_kind: "script",
    evaluator: metric, reducer: `deterministic_${metric}`,
    requires, invalidated_by,
    estimated_cost: { model_calls: 0, render_required: false },
  };
}

const SOURCES = ["sources/classified_sources.jsonl"];
const CHAPTERS = ["chapters/**"];
const EVIDENCE = ["evidence/**"];
const FIGURES = ["figures/**"];

const DEFINITIONS: MetricDefinition[] = [
  // Corpus and source metrics.
  script("core_sources", "maximize", "count", "unit", SOURCES, SOURCES),
  script("cited_sources", "maximize", "count", "unit", [...SOURCES, ...EVIDENCE], [...CHAPTERS, ...EVIDENCE]),
  script("cited_within_one_year_ratio", "maximize", "ratio", "unit", SOURCES, [...CHAPTERS, ...SOURCES]),
  script("accepted_cited_ratio", "maximize", "ratio", "unit", SOURCES, [...CHAPTERS, ...SOURCES]),
  script("cited_arxiv_only_ratio", "minimize", "ratio", "unit", SOURCES, [...CHAPTERS, ...SOURCES]),
  script("citation_depth_per_section", "maximize", "count", "unit", [...SOURCES, ...EVIDENCE], [...CHAPTERS, ...EVIDENCE]),
  script("taxonomy_cell_ab_sources", "maximize", "count", "unit", SOURCES, SOURCES),
  script("landmark_coverage_ratio", "maximize", "ratio", "unit", [...SOURCES, "reports/landmarks.json"], [...SOURCES, ...EVIDENCE]),
  script("landmark_citation_coverage_ratio", "maximize", "ratio", "unit", ["reports/landmarks.json", ...CHAPTERS], CHAPTERS),
  // Manuscript metrics.
  script("prose_redundancy", "minimize", "count", "unit", CHAPTERS, CHAPTERS),
  script("claim_contradictions", "minimize", "count", "round", [...CHAPTERS, "reviews/claim-judgments.jsonl"], CHAPTERS),
  script("outline_readiness", "maximize", "boolean", "unit", ["outline.json"], ["outline.json", "outline.md"]),
  // Artifact metrics.
  script("figures", "maximize", "count", "unit", ["figures/manifest.json"], FIGURES),
  script("tables", "maximize", "count", "unit", ["figures/manifest.json"], FIGURES),
  script("comparative_tables", "maximize", "count", "unit", ["figures/manifest.json"], FIGURES),
  script("verified_metadata_plots", "maximize", "count", "unit", ["figures/manifest.json"], FIGURES),
  script("diagram_connectivity", "minimize", "count", "unit", ["figures/placement-plan.json"], FIGURES),
  script("empirical_trials", "maximize", "count", "unit", ["experiments/results.json"], ["experiments/**"]),
  // Page-dependent: needs a build, so it defers to the round boundary.
  { ...script("citations_per_page", "maximize", "ratio", "round", ["build/manuscript.pdf", ...CHAPTERS], [...CHAPTERS, "paper/**"]),
    estimated_cost: { model_calls: 0, render_required: true } },
  // Model pipelines.
  {
    metric: metricId("review_score"), direction: "maximize", target_type: "score",
    measurement_tier: "release", measurement_kind: "model",
    evaluator: "review_score", producer: "persona_review", validator: "scorecard_schema",
    reducer: "deterministic_review_score",
    requires: ["reviews/scorecard.json"], invalidated_by: [...CHAPTERS, "paper/**", ...FIGURES],
    estimated_cost: { model_calls: 5, render_required: false },
  },
  {
    metric: metricId("claim_support"), direction: "maximize", target_type: "ratio",
    measurement_tier: "release", measurement_kind: "model",
    evaluator: "claim_support", producer: "claim_double_review", validator: "claim_judgment_schema",
    reducer: "deterministic_claim_support_rate",
    requires: ["reviews/claim-judgments.jsonl"], invalidated_by: [...CHAPTERS, ...EVIDENCE],
    estimated_cost: { model_calls: 2, render_required: false },
  },
  {
    metric: metricId("rendered_visual_review"), direction: "maximize", target_type: "boolean",
    measurement_tier: "release", measurement_kind: "model",
    evaluator: "rendered_visual_review", producer: "multimodal_page_review", validator: "visual_qa_schema",
    reducer: "deterministic_visual_verdict",
    requires: ["build/manuscript.pdf", "reviews/visual-qa.json"],
    invalidated_by: [...CHAPTERS, ...FIGURES, "paper/**"],
    estimated_cost: { model_calls: 1, render_required: true },
  },
];

export const METRIC_REGISTRY: ReadonlyMap<MetricId, MetricDefinition> =
  new Map(DEFINITIONS.map((definition) => [definition.metric, definition]));

export function metricDefinition(id: MetricId): MetricDefinition {
  const found = METRIC_REGISTRY.get(id);
  if (!found) throw new Error(`unknown metric: ${id}. Add it to src/lib/registry/metrics.ts.`);
  return found;
}

function matches(pattern: string, filePath: string): boolean {
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -2));
  return pattern === filePath;
}

/** Only re-measure what a change actually invalidated. This is what keeps a
 * `release`-tier metric from being recomputed after every unrelated repair. */
export function metricsInvalidatedBy(changed: string[]): MetricId[] {
  return [...METRIC_REGISTRY.values()]
    .filter((definition) => definition.invalidated_by.some((pattern) => changed.some((file) => matches(pattern, file))))
    .map((definition) => definition.metric);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-metrics`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/metrics.ts packages/longwrite/tests/registry-metrics.test.ts
git commit -m "feat(registry): declare measurement pipelines, tiers and invalidation for all 22 metrics"
```

---

### Task 7: Observation store with digest-based freshness

**Files:**
- Create: `packages/longwrite/src/lib/registry/observations.ts`
- Test: `packages/longwrite/tests/registry-observations.test.ts`

**Interfaces:**
- Consumes: `Observation`, `ObservationSchema` (Task 5); `metricDefinition` (Task 6).
- Produces: `computeInputDigest(workspaceDir, definition, extra?): Promise<string>`; `appendObservation(workspaceDir, observation): Promise<string>` returning the written path; `currentValues(workspaceDir): Promise<Map<string, Observation>>`; `findReusable(workspaceDir, metric, inputDigest, evaluatorDigest): Promise<Observation | null>`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-observations.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metricId } from "../src/lib/registry/ids.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import {
  appendObservation, computeInputDigest, currentValues, findReusable,
} from "../src/lib/registry/observations.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-observations-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One\n", "utf-8");
  return ws;
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    metric: "prose_redundancy", value: 0, evaluator: "prose_redundancy",
    evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
    sequence: 1, measured_at: new Date().toISOString(), ...overrides,
  };
}

describe("observation store", () => {
  it("writes an immutable content-addressed record", async () => {
    const ws = await workspace();
    const written = await appendObservation(ws, observation() as never);
    expect(written).toContain(path.join(".malaclaw", "observations", "prose_redundancy"));
    expect(JSON.parse(await fs.readFile(written, "utf-8")).value).toBe(0);
  });

  it("resolves the current value by highest sequence, not by clock", async () => {
    const ws = await workspace();
    // Written second but sequenced first: a slow evaluator finishing late must
    // not overwrite a newer result.
    await appendObservation(ws, observation({ value: 3, sequence: 9 }) as never);
    await appendObservation(ws, observation({
      value: 7, sequence: 4, input_digest: "c".repeat(64),
      measured_at: new Date(Date.now() + 60_000).toISOString(),
    }) as never);
    const current = await currentValues(ws);
    expect(current.get("prose_redundancy")?.value).toBe(3);
  });

  it("reuses an observation only when both digests match", async () => {
    const ws = await workspace();
    await appendObservation(ws, observation({ value: 2 }) as never);
    const hit = await findReusable(ws, metricId("prose_redundancy"), "b".repeat(64), "a".repeat(64));
    expect(hit?.value).toBe(2);
    const missInput = await findReusable(ws, metricId("prose_redundancy"), "d".repeat(64), "a".repeat(64));
    expect(missInput).toBeNull();
    const missEvaluator = await findReusable(ws, metricId("prose_redundancy"), "b".repeat(64), "e".repeat(64));
    expect(missEvaluator).toBeNull();
  });

  it("changes the input digest when a declared dependency changes", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("prose_redundancy"));
    const before = await computeInputDigest(ws, definition);
    await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One, revised\n", "utf-8");
    const after = await computeInputDigest(ws, definition);
    expect(after).not.toBe(before);
  });

  it("includes extra configuration in the input digest for model pipelines", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("review_score"));
    const a = await computeInputDigest(ws, definition, { model: "opus", prompt_version: 3 });
    const b = await computeInputDigest(ws, definition, { model: "opus", prompt_version: 4 });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-observations`
Expected: FAIL — cannot resolve `observations.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/observations.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ObservationSchema, type Observation } from "./records.js";
import type { MetricDefinition } from "./metrics.js";
import type { MetricId } from "./ids.js";

const ROOT = path.join(".malaclaw", "observations");

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

async function digestOfPattern(workspaceDir: string, pattern: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const targets = pattern.endsWith("/**")
    ? await filesUnder(path.join(workspaceDir, pattern.slice(0, -3)))
    : [path.join(workspaceDir, pattern)];
  for (const target of targets) {
    const bytes = await fs.readFile(target).catch(() => Buffer.alloc(0));
    hash.update(path.relative(workspaceDir, target)).update(bytes);
  }
  return hash.digest("hex");
}

/** Covers the declared reads, the registry configuration, and — for a model
 * pipeline — the prompt and model configuration passed as `extra`. The same
 * manuscript re-reviewed by a different model is a different measurement, so
 * it must not reuse the earlier observation. */
export async function computeInputDigest(
  workspaceDir: string,
  definition: MetricDefinition,
  extra?: Record<string, unknown>,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(definition.metric).update(definition.evaluator).update(definition.reducer);
  hash.update(JSON.stringify(definition.requires)).update(JSON.stringify(definition.invalidated_by));
  for (const pattern of [...definition.requires].sort()) {
    hash.update(pattern).update(await digestOfPattern(workspaceDir, pattern));
  }
  if (extra) hash.update(JSON.stringify(extra, Object.keys(extra).sort()));
  return hash.digest("hex");
}

/** Immutable, content-addressed, atomically renamed. Nothing mutates an
 * existing record, so concurrent fan-out writers cannot clobber each other. */
export async function appendObservation(workspaceDir: string, observation: Observation): Promise<string> {
  const parsed = ObservationSchema.parse(observation);
  const dir = path.join(workspaceDir, ROOT, parsed.metric, parsed.input_digest, parsed.evaluator);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${String(parsed.sequence).padStart(12, "0")}.json`);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return target;
}

async function allObservations(workspaceDir: string): Promise<Observation[]> {
  const files = await filesUnder(path.join(workspaceDir, ROOT));
  const records: Observation[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const parsed = ObservationSchema.safeParse(JSON.parse(await fs.readFile(file, "utf-8")));
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

/** Highest `sequence` wins. Never `measured_at`: under fan-out, clock order and
 * causal order diverge and a slow evaluator would overwrite a newer result. */
export async function currentValues(workspaceDir: string): Promise<Map<string, Observation>> {
  const current = new Map<string, Observation>();
  for (const record of await allObservations(workspaceDir)) {
    const held = current.get(record.metric);
    if (!held || record.sequence > held.sequence) current.set(record.metric, record);
  }
  return current;
}

export async function findReusable(
  workspaceDir: string,
  metric: MetricId,
  inputDigest: string,
  evaluatorDigest: string,
): Promise<Observation | null> {
  const matching = (await allObservations(workspaceDir)).filter((record) =>
    record.metric === metric && record.input_digest === inputDigest && record.evaluator_digest === evaluatorDigest);
  if (matching.length === 0) return null;
  return matching.reduce((best, record) => (record.sequence > best.sequence ? record : best));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-observations`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/observations.ts packages/longwrite/tests/registry-observations.test.ts
git commit -m "feat(registry): add immutable observation store with digest-based freshness"
```

---

### Task 8: Acceptance evaluation with gap-relative progress

**Files:**
- Create: `packages/longwrite/src/lib/registry/acceptance.ts`
- Test: `packages/longwrite/tests/registry-acceptance.test.ts`

**Interfaces:**
- Consumes: `Observation` (Task 5); `metricDefinition` (Task 6).
- Produces: type `Criterion = { metric: MetricId; operator: "at_least" | "at_most" | "equals"; target: number; scope?: string }`; type `ProgressPolicy = { min_absolute_delta: number; min_gap_fraction: number; max_attempts: number }`; `satisfies(criterion, value): boolean`; `closedGapFraction(criterion, before, after): number`; `evaluateProgress(criterion, policy, before, after): "accepted" | "improved" | "unmet"`; `objectiveKey(criterion, findingIds, artifactIds): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-acceptance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import {
  closedGapFraction, evaluateProgress, objectiveKey, satisfies,
} from "../src/lib/registry/acceptance.js";

const coverage = { metric: metricId("landmark_coverage_ratio"), operator: "at_least" as const, target: 0.75 };
const redundancy = { metric: metricId("prose_redundancy"), operator: "at_most" as const, target: 0 };
const policy = { min_absolute_delta: 0.01, min_gap_fraction: 0.2, max_attempts: 2 };

describe("acceptance evaluation", () => {
  it("satisfies an at_least criterion at or above target", () => {
    expect(satisfies(coverage, 0.75)).toBe(true);
    expect(satisfies(coverage, 0.74)).toBe(false);
  });

  it("satisfies an at_most criterion at or below target", () => {
    expect(satisfies(redundancy, 0)).toBe(true);
    expect(satisfies(redundancy, 1)).toBe(false);
  });

  it("measures progress against the remaining gap, not the raw delta", () => {
    // 0.083 -> 0.25 closes (0.25-0.083)/(0.75-0.083) = 25% of the gap.
    expect(closedGapFraction(coverage, 0.083, 0.25)).toBeCloseTo(0.25, 2);
  });

  it("inverts the gap calculation for at_most criteria", () => {
    expect(closedGapFraction(redundancy, 10, 5)).toBeCloseTo(0.5, 5);
  });

  it("accepts when the target is reached", () => {
    expect(evaluateProgress(coverage, policy, 0.5, 0.8)).toBe("accepted");
  });

  it("reports improved when both thresholds are met but the target is not", () => {
    expect(evaluateProgress(coverage, policy, 0.083, 0.25)).toBe("improved");
  });

  it("rejects a slow crawl that passes the absolute delta but not the gap fraction", () => {
    // +0.02 absolute clears min_absolute_delta but closes only 3% of the gap;
    // accepting this permits ~25 legal rounds of no real movement.
    expect(evaluateProgress(coverage, policy, 0.083, 0.103)).toBe("unmet");
  });

  it("rejects movement below the absolute delta even when the gap is tiny", () => {
    expect(evaluateProgress(coverage, policy, 0.745, 0.7455)).toBe("unmet");
  });

  it("keys an objective by scope so one section cannot reset another", () => {
    const section3 = objectiveKey(
      { metric: metricId("citation_depth_per_section"), operator: "at_least", target: 1, scope: "section-03" },
      ["f1"], ["chapters/section-03.md"]);
    const section6 = objectiveKey(
      { metric: metricId("citation_depth_per_section"), operator: "at_least", target: 1, scope: "section-06" },
      ["f1"], ["chapters/section-06.md"]);
    expect(section3).not.toBe(section6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-acceptance`
Expected: FAIL — cannot resolve `acceptance.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/acceptance.ts`:

```ts
import crypto from "node:crypto";
import type { MetricId } from "./ids.js";

export type Criterion = {
  metric: MetricId;
  operator: "at_least" | "at_most" | "equals";
  target: number;
  scope?: string;
};

export type ProgressPolicy = {
  min_absolute_delta: number;
  min_gap_fraction: number;
  max_attempts: number;
};

export function satisfies(criterion: Criterion, value: number): boolean {
  if (criterion.operator === "at_least") return value >= criterion.target;
  if (criterion.operator === "at_most") return value <= criterion.target;
  return value === criterion.target;
}

/** Fraction of the remaining distance to target that this attempt closed.
 *
 * A raw delta is the wrong unit: +0.01 on a ratio metric is satisfiable roughly
 * twenty-five times in a row, which is a legal slow crawl and structurally the
 * same failure as a review score drifting while nothing real changes. */
export function closedGapFraction(criterion: Criterion, before: number, after: number): number {
  const gap = criterion.operator === "at_most" ? before - criterion.target : criterion.target - before;
  if (gap <= 0) return 1;
  const moved = criterion.operator === "at_most" ? before - after : after - before;
  return moved / gap;
}

export function evaluateProgress(
  criterion: Criterion,
  policy: ProgressPolicy,
  before: number,
  after: number,
): "accepted" | "improved" | "unmet" {
  if (satisfies(criterion, after)) return "accepted";
  const absolute = criterion.operator === "at_most" ? before - after : after - before;
  if (absolute < policy.min_absolute_delta) return "unmet";
  if (closedGapFraction(criterion, before, after) < policy.min_gap_fraction) return "unmet";
  return "improved";
}

/** Objective identity includes scope.
 *
 * Keyed on the metric alone, an improvement in section 3 would reset the
 * stagnation counter for section 6 — a slow crawl wearing the appearance of
 * progress. */
export function objectiveKey(criterion: Criterion, findingIds: string[], artifactIds: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    criterion.metric, criterion.operator, criterion.target, criterion.scope ?? "",
    [...findingIds].sort(), [...artifactIds].sort(),
  ])).digest("hex").slice(0, 32);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-acceptance`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/acceptance.ts packages/longwrite/tests/registry-acceptance.test.ts
git commit -m "feat(registry): evaluate acceptance with gap-relative progress and scoped objective keys"
```

---

### Task 9: Script evaluators for corpus and citation metrics

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluators/corpus.ts`
- Test: `packages/longwrite/tests/registry-evaluators-corpus.test.ts`

**Interfaces:**
- Consumes: `Observation` (Task 5); `metricDefinition`, `MetricDefinition` (Task 6); `computeInputDigest`, `appendObservation` (Task 7).
- Produces: type `EvaluatorFn = (workspaceDir: string) => Promise<number>`; `CORPUS_EVALUATORS: Record<string, EvaluatorFn>` keyed by metric name, covering `core_sources`, `cited_within_one_year_ratio`, `accepted_cited_ratio`, `cited_arxiv_only_ratio`, `taxonomy_cell_ab_sources`, `landmark_coverage_ratio`.

Exact formulas, all reading `sources/classified_sources.jsonl` (one JSON object per line):

- `core_sources` — count of records whose `citation_depth` is `"A"` or `"B"`.
- `cited_within_one_year_ratio` — of records cited in `chapters/*.md` via a `[source:<id>:…]` marker, the fraction whose `year` is within one year of the current year.
- `accepted_cited_ratio` — of cited records, the fraction where `identity.publication_status` matches `/(accepted|published|inproceedings|journal|proceedings)/i`, or a `identifiers.doi` exists and `venue` does not match `/(arxiv|preprint|unknown)/i`. Reuse the exact policy in `src/lib/ops/action-plan.ts` `isAcceptedSource`, which this task extracts into a shared helper.
- `cited_arxiv_only_ratio` — of cited records, the fraction that are not accepted by the rule above.
- `taxonomy_cell_ab_sources` — the minimum, across configured taxonomy cells, of A/B-depth sources matching that cell via `sourceMatchesTaxonomy`.
- `landmark_coverage_ratio` — of the landmark works in `reports/landmarks.json`, the fraction whose source id appears in `evidence/active-validated-source-evidence.json` with at least one claim.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluators-corpus.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CORPUS_EVALUATORS } from "../src/lib/registry/evaluators/corpus.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(sources: unknown[], chapters: Record<string, string> = {}): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-corpus-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  for (const [name, body] of Object.entries(chapters)) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  return ws;
}

describe("corpus evaluators", () => {
  it("counts A and B depth sources as core", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A" },
      { id: "s2", citation_depth: "B" },
      { id: "s3", citation_depth: "C" },
    ]);
    expect(await CORPUS_EVALUATORS.core_sources(ws)).toBe(2);
  });

  it("returns zero core sources when the corpus file is missing", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-empty-"));
    roots.push(ws);
    expect(await CORPUS_EVALUATORS.core_sources(ws)).toBe(0);
  });

  it("measures the accepted ratio over cited sources only", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A", identity: { publication_status: "published" } },
      { id: "s2", citation_depth: "A", venue: "arXiv", identity: { publication_status: "preprint" } },
      { id: "s3", citation_depth: "A", identity: { publication_status: "published" } },
    ], { "section-01.md": "Text [source:s1:p1] and [source:s2:p2].\n" });
    // s3 is uncited and must not dilute the ratio: 1 accepted of 2 cited.
    expect(await CORPUS_EVALUATORS.accepted_cited_ratio(ws)).toBeCloseTo(0.5, 5);
  });

  it("treats arxiv-only as the complement of accepted", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A", identity: { publication_status: "published" } },
      { id: "s2", citation_depth: "A", venue: "arXiv", identity: { publication_status: "preprint" } },
    ], { "section-01.md": "[source:s1:p1] [source:s2:p2]\n" });
    expect(await CORPUS_EVALUATORS.cited_arxiv_only_ratio(ws)).toBeCloseTo(0.5, 5);
  });

  it("returns a zero ratio rather than NaN when nothing is cited", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A" }], { "section-01.md": "No markers.\n" });
    expect(await CORPUS_EVALUATORS.accepted_cited_ratio(ws)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-corpus`
Expected: FAIL — cannot resolve `evaluators/corpus.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/evaluators/corpus.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";

export type EvaluatorFn = (workspaceDir: string) => Promise<number>;

type SourceRecord = {
  id?: unknown;
  citation_depth?: unknown;
  year?: unknown;
  venue?: unknown;
  identity?: { publication_status?: unknown };
  identifiers?: { doi?: unknown };
};

async function readSources(workspaceDir: string): Promise<SourceRecord[]> {
  const raw = await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8")
    .catch(() => "");
  return raw.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as SourceRecord]; } catch { return []; }
  });
}

const MARKER = /\[source:([^:\]]+):/g;

async function citedSourceIds(workspaceDir: string): Promise<Set<string>> {
  const dir = path.join(workspaceDir, "chapters");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const ids = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const body = await fs.readFile(path.join(dir, name), "utf-8").catch(() => "");
    for (const match of body.matchAll(MARKER)) ids.add(match[1]);
  }
  return ids;
}

/** The same conservative policy the release validator uses: a DOI is a useful
 * acceptance signal only when the record is not explicitly a preprint or an
 * unknown venue. Extracted here so the evaluator and the gate cannot drift. */
export function isAcceptedSource(record: SourceRecord): boolean {
  const status = typeof record.identity?.publication_status === "string"
    ? record.identity.publication_status.toLowerCase() : "";
  if (/(accepted|published|inproceedings|journal|proceedings)/.test(status)) return true;
  return typeof record.identifiers?.doi === "string"
    && !/(arxiv|preprint|unknown)/i.test(typeof record.venue === "string" ? record.venue : "");
}

/** An empty denominator is 0, never NaN: a NaN observation would fail schema
 * validation and surface as `measurement_failed` rather than as the real
 * condition, which is "nothing is cited yet". */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

async function citedRecords(workspaceDir: string): Promise<SourceRecord[]> {
  const cited = await citedSourceIds(workspaceDir);
  return (await readSources(workspaceDir))
    .filter((record) => typeof record.id === "string" && cited.has(record.id));
}

export const CORPUS_EVALUATORS: Record<string, EvaluatorFn> = {
  core_sources: async (ws) =>
    (await readSources(ws)).filter((r) => r.citation_depth === "A" || r.citation_depth === "B").length,

  accepted_cited_ratio: async (ws) => {
    const cited = await citedRecords(ws);
    return ratio(cited.filter(isAcceptedSource).length, cited.length);
  },

  cited_arxiv_only_ratio: async (ws) => {
    const cited = await citedRecords(ws);
    return ratio(cited.filter((r) => !isAcceptedSource(r)).length, cited.length);
  },

  cited_within_one_year_ratio: async (ws) => {
    const cited = await citedRecords(ws);
    const cutoff = new Date().getFullYear() - 1;
    return ratio(cited.filter((r) => typeof r.year === "number" && r.year >= cutoff).length, cited.length);
  },
};
```

Add `taxonomy_cell_ab_sources` and `landmark_coverage_ratio` to the same object using the formulas stated above, importing `sourceMatchesTaxonomy` from `../../research/taxonomy.js` and `loadProjectConfig` from `../../project-config.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-corpus`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluators/corpus.ts packages/longwrite/tests/registry-evaluators-corpus.test.ts
git commit -m "feat(registry): add deterministic corpus and citation metric evaluators"
```

---

### Task 10: `longwrite metrics evaluate` command

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluate.ts`
- Modify: `packages/longwrite/src/commands/metrics.ts` (add `runMetricsEvaluate`)
- Modify: `packages/longwrite/src/cli.ts:294-302` (register the subcommand under the existing `metrics` group)
- Test: `packages/longwrite/tests/registry-evaluate.test.ts`

**Interfaces:**
- Consumes: `CORPUS_EVALUATORS` (Task 9); `metricDefinition`, `METRIC_REGISTRY` (Task 6); `computeInputDigest`, `appendObservation`, `findReusable`, `currentValues` (Task 7).
- Produces: `evaluateMetrics(workspaceDir, options: { metrics?: MetricId[]; tier?: "unit" | "round" | "release"; sequence: number }): Promise<{ measured: Observation[]; reused: Observation[]; skipped: string[] }>`; `runMetricsEvaluate(workspaceDir: string, options: { tier?: string }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluate.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metricId } from "../src/lib/registry/ids.js";
import { evaluateMetrics } from "../src/lib/registry/evaluate.js";
import { currentValues } from "../src/lib/registry/observations.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evaluate-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    [{ id: "s1", citation_depth: "A" }, { id: "s2", citation_depth: "B" }]
      .map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("metrics evaluate", () => {
  it("measures a requested metric and stores the observation", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], sequence: 1 });
    expect(result.measured).toHaveLength(1);
    expect(result.measured[0].value).toBe(2);
    expect((await currentValues(ws)).get("core_sources")?.value).toBe(2);
  });

  it("reuses an unchanged observation instead of re-measuring", async () => {
    const ws = await workspace();
    await evaluateMetrics(ws, { metrics: [metricId("core_sources")], sequence: 1 });
    const second = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], sequence: 2 });
    expect(second.measured).toHaveLength(0);
    expect(second.reused).toHaveLength(1);
  });

  it("re-measures once a declared dependency changes", async () => {
    const ws = await workspace();
    await evaluateMetrics(ws, { metrics: [metricId("core_sources")], sequence: 1 });
    await fs.appendFile(path.join(ws, "sources", "classified_sources.jsonl"),
      `\n${JSON.stringify({ id: "s3", citation_depth: "A" })}`, "utf-8");
    const third = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], sequence: 2 });
    expect(third.measured).toHaveLength(1);
    expect(third.measured[0].value).toBe(3);
  });

  it("skips a metric that has no script evaluator yet, rather than inventing a value", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, { metrics: [metricId("review_score")], sequence: 1 });
    expect(result.measured).toHaveLength(0);
    expect(result.skipped).toContain("review_score");
  });

  it("selects only the metrics on the requested tier", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, { tier: "release", sequence: 1 });
    expect(result.measured).toHaveLength(0);
    expect(result.skipped.sort()).toEqual(["claim_support", "rendered_visual_review", "review_score"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluate`
Expected: FAIL — cannot resolve `evaluate.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/evaluate.ts`:

```ts
import crypto from "node:crypto";
import { METRIC_REGISTRY, metricDefinition } from "./metrics.js";
import { appendObservation, computeInputDigest, findReusable } from "./observations.js";
import { ObservationSchema, type Observation } from "./records.js";
import type { MetricId } from "./ids.js";
import { CORPUS_EVALUATORS, type EvaluatorFn } from "./evaluators/corpus.js";

const SCRIPT_EVALUATORS: Record<string, EvaluatorFn> = { ...CORPUS_EVALUATORS };

/** Identity of the evaluator implementation plus its configuration. Bump when
 * an evaluator's formula changes: prior observations must not be reused across
 * a semantic change to how a number is produced. */
const EVALUATOR_VERSION = "1";

function evaluatorDigest(name: string): string {
  return crypto.createHash("sha256").update(`${name}\u0000${EVALUATOR_VERSION}`).digest("hex");
}

export async function evaluateMetrics(
  workspaceDir: string,
  options: { metrics?: MetricId[]; tier?: "unit" | "round" | "release"; sequence: number },
): Promise<{ measured: Observation[]; reused: Observation[]; skipped: string[] }> {
  const selected = options.metrics
    ?? [...METRIC_REGISTRY.values()]
      .filter((definition) => !options.tier || definition.measurement_tier === options.tier)
      .map((definition) => definition.metric);

  const measured: Observation[] = [];
  const reused: Observation[] = [];
  const skipped: string[] = [];

  for (const metric of selected) {
    const definition = metricDefinition(metric);
    const evaluator = SCRIPT_EVALUATORS[String(metric)];
    if (!evaluator) {
      // A model or external pipeline is produced by its own unit; inventing a
      // number here is exactly the self-grading this design removes.
      skipped.push(String(metric));
      continue;
    }
    const inputDigest = await computeInputDigest(workspaceDir, definition);
    const digest = evaluatorDigest(definition.evaluator);
    const hit = await findReusable(workspaceDir, metric, inputDigest, digest);
    if (hit) { reused.push(hit); continue; }

    const observation = ObservationSchema.parse({
      metric: String(metric),
      value: await evaluator(workspaceDir),
      evaluator: definition.evaluator,
      evaluator_digest: digest,
      input_digest: inputDigest,
      sequence: options.sequence,
      measured_at: new Date().toISOString(),
    });
    await appendObservation(workspaceDir, observation);
    measured.push(observation);
  }
  return { measured, reused, skipped };
}
```

Add to `packages/longwrite/src/commands/metrics.ts`:

```ts
import { evaluateMetrics } from "../lib/registry/evaluate.js";
import { currentValues } from "../lib/registry/observations.js";

export async function runMetricsEvaluate(
  workspaceDir: string,
  options: { tier?: "unit" | "round" | "release" },
): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const current = await currentValues(resolved);
  const sequence = Math.max(0, ...[...current.values()].map((o) => o.sequence)) + 1;
  const result = await evaluateMetrics(resolved, { tier: options.tier, sequence });
  console.log(`Measured ${result.measured.length}, reused ${result.reused.length}, skipped ${result.skipped.length}`);
  for (const observation of result.measured) console.log(`  = ${observation.metric}: ${observation.value}`);
  for (const observation of result.reused) console.log(`  ~ ${observation.metric}: ${observation.value} (unchanged)`);
  for (const metric of result.skipped) console.log(`  - ${metric}: produced by its own measurement unit`);
}
```

Register in `packages/longwrite/src/cli.ts`, inside the existing `metrics` command group:

```ts
metrics
  .command("evaluate <workspace>")
  .description("Measure acceptance metrics and append immutable observations")
  .option("--tier <tier>", "only measure metrics on this tier (unit, round, release)")
  .action(async (workspace, options) => {
    const { runMetricsEvaluate } = await import("./commands/metrics.js");
    await runMetricsEvaluate(workspace, options);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluate`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the full suite and build still pass**

Run: `npm run build --workspace @mr-maliang/longwrite && npm test --workspace @mr-maliang/longwrite`
Expected: build succeeds, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluate.ts packages/longwrite/src/commands/metrics.ts packages/longwrite/src/cli.ts packages/longwrite/tests/registry-evaluate.test.ts
git commit -m "feat(cli): add longwrite metrics evaluate with digest-based observation reuse"
```

---

### Task 11: Emit structured findings from the figures validator

Converts the first real gate producer. `checkManuscriptReferences` already holds `item.id` and the owning path at `src/lib/validation/figures.ts:238-256`; this stops it throwing them away.

**Files:**
- Modify: `packages/longwrite/src/lib/validation/figures.ts:220-260`
- Test: `packages/longwrite/tests/figures-structured-findings.test.ts`

**Interfaces:**
- Consumes: `FindingSchema`, `Finding` (Task 5); `resolveCapability` (Task 3).
- Produces: `checkManuscriptReferences` returns `StructuredCheck` rather than `ValidationCheck`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/figures-structured-findings.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkManuscriptReferences } from "../src/lib/validation/figures.js";
import { resolveCapability } from "../src/lib/registry/routing.js";
import { FindingSchema } from "../src/lib/registry/records.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-figures-structured-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "paper", "sections"), { recursive: true });
  await fs.mkdir(path.join(ws, "figures"), { recursive: true });
  await fs.writeFile(path.join(ws, "paper", "main.tex"), "\\documentclass{article}\n", "utf-8");
  // Section exists but neither labels nor embeds the figure.
  await fs.writeFile(path.join(ws, "paper", "sections", "section-03.tex"), "Some prose.\n", "utf-8");
  await fs.writeFile(path.join(ws, "figures", "manifest.json"), JSON.stringify({
    version: 1,
    figures: [{ id: "figure-1", latex_path: "paper/figures/figure-1.tex", placement: { section_id: "section-03" } }],
    tables: [],
  }), "utf-8");
  return ws;
}

describe("figures validator structured findings", () => {
  it("emits findings that validate against the registry schema", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws);
    expect(check.pass).toBe(false);
    expect(check.findings.length).toBeGreaterThan(0);
    for (const finding of check.findings) {
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    }
  });

  it("names the owning artifact instead of embedding it in prose", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws);
    const missingEmbed = check.findings.find((f) => f.required_effect === "repair_artifact_placement");
    expect(missingEmbed?.artifact.path).toBe("paper/sections/section-03.tex");
    expect(missingEmbed?.artifact.artifact_id).toBe("figure-1");
  });

  it("emits findings every one of which resolves to a capability", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws);
    for (const finding of check.findings) {
      expect(() => resolveCapability({
        gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
      })).not.toThrow();
    }
  });

  it("keeps human prose available as a diagnostic on each finding", async () => {
    const ws = await workspace();
    const check = await checkManuscriptReferences(ws);
    expect(check.findings[0].diagnostic).toMatch(/figure-1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- figures-structured-findings`
Expected: FAIL — `check.findings[0]` is a string, so `FindingSchema.safeParse` fails and `.artifact` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/longwrite/src/lib/validation/figures.ts`, replace the string pushes inside `checkManuscriptReferences` with structured findings:

```ts
import { FindingSchema, type Finding, type StructuredCheck } from "../registry/records.js";
import { gateId } from "../registry/ids.js";

const FIGURE_REFERENCES = gateId("figure_references");

function placementFinding(
  artifactId: string,
  sectionPath: string,
  effect: "repair_artifact_placement" | "repair_artifact_content",
  diagnostic: string,
): Finding {
  return FindingSchema.parse({
    id: `${artifactId}-${effect}`,
    gate_id: FIGURE_REFERENCES,
    artifact: { kind: "figure_spec", path: sectionPath, artifact_id: artifactId },
    required_effect: effect,
    severity: "major",
    diagnostic,
  });
}
```

Then, inside `embedded()`, replace each `findings.push("figure_references: …")` with the corresponding `placementFinding(...)` call, keeping the original message as the `diagnostic`. Change the return to:

```ts
return {
  id: FIGURE_REFERENCES,
  pass: findings.length === 0,
  observations: [],
  findings,
} satisfies StructuredCheck;
```

Update `validateFigureWorkspace` so its `checks` array is typed `StructuredCheck[]`, and update any caller that read `check.findings` as `string[]` to read `check.findings.map((f) => f.diagnostic)` for display only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- figures-structured-findings`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the existing figures suite to catch regressions**

Run: `npm test --workspace @mr-maliang/longwrite -- figures`
Expected: PASS. `tests/figures.test.ts` asserts on finding strings; update those assertions to read `.diagnostic`. Do not weaken an assertion to make it pass.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/validation/figures.ts packages/longwrite/tests/figures-structured-findings.test.ts packages/longwrite/tests/figures.test.ts
git commit -m "feat(validation): emit structured findings with artifact and effect from the figures gate"
```

---

### Task 12: Emit structured observations from the corpus gates

**Files:**
- Modify: `packages/longwrite/src/lib/research/corpus-gates.ts:60-95`
- Test: `packages/longwrite/tests/corpus-gates-observations.test.ts`

**Interfaces:**
- Consumes: `ObservationSchema` (Task 5); `metricDefinition` (Task 6); `evaluatorDigest` behavior from Task 10 — export it from `src/lib/registry/evaluate.ts` as `evaluatorDigest(name: string): string`.
- Produces: `CorpusGateReport` gains `observations: Observation[]`; `CorpusGateFinding` gains `observation?: Observation`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/corpus-gates-observations.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { evaluateCorpusGates } from "../src/lib/research/corpus-gates.js";
import { ObservationSchema } from "../src/lib/registry/records.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-corpus-obs-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1,
    project: { id: "survey", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi", topic: "agent memory", taxonomy: ["memory"],
      corpus_gates: {
        min_candidates: 1, min_sources_per_taxonomy_cell: 0, min_core_sources: 5,
        min_recent_ratio: 0, min_source_type_diversity: 1,
      },
    },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    [{ id: "s1", citation_depth: "A", source: "arxiv", topics: ["memory"] },
     { id: "s2", citation_depth: "B", source: "arxiv", topics: ["memory"] }]
      .map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("corpus gates observations", () => {
  it("emits a numeric observation alongside the pass flag", async () => {
    const ws = await workspace();
    const report = await evaluateCorpusGates(ws);
    const core = report.observations.find((o) => o.metric === "core_sources");
    expect(core).toBeDefined();
    expect(ObservationSchema.safeParse(core).success).toBe(true);
  });

  it("carries the measured value and its target, not just prose", async () => {
    const ws = await workspace();
    const report = await evaluateCorpusGates(ws);
    const core = report.observations.find((o) => o.metric === "core_sources");
    expect(core?.value).toBe(2);
    expect(core?.target).toBe(5);
    expect(core?.operator).toBe("at_least");
  });

  it("keeps the existing prose detail for operators", async () => {
    const ws = await workspace();
    const report = await evaluateCorpusGates(ws);
    const finding = report.findings.find((f) => f.id === "core_sources");
    expect(finding?.detail).toContain("required 5");
    expect(finding?.pass).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates-observations`
Expected: FAIL — `report.observations` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/longwrite/src/lib/research/corpus-gates.ts`, add an observation helper and attach one to each numeric gate:

```ts
import { ObservationSchema, type Observation } from "../registry/records.js";
import { evaluatorDigest } from "../registry/evaluate.js";
import { computeInputDigest } from "../registry/observations.js";
import { metricDefinition } from "../registry/metrics.js";
import { metricId } from "../registry/ids.js";

async function observe(
  workspaceDir: string,
  metric: string,
  value: number,
  target: number,
  operator: "at_least" | "at_most",
  sequence: number,
): Promise<Observation> {
  const definition = metricDefinition(metricId(metric));
  return ObservationSchema.parse({
    metric, value, target, operator,
    evaluator: definition.evaluator,
    evaluator_digest: evaluatorDigest(definition.evaluator),
    input_digest: await computeInputDigest(workspaceDir, definition),
    sequence,
    measured_at: new Date().toISOString(),
  });
}
```

In `evaluateCorpusGates`, build an `observations` array with entries for `core_sources` (value `coreSourceCount`, target `gates.min_core_sources`, `at_least`), `total_candidates` (value `sources.length`, target `gates.min_candidates`, `at_least`), and `source_type_diversity` (value `sourceTypeCount`, target `gates.min_source_type_diversity`, `at_least`). Add `observations` to the returned `CorpusGateReport` and to its type. Leave every existing `detail` string exactly as it is — prose stays, it just stops being the only representation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates-observations`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the existing corpus-gates suite**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates`
Expected: PASS, unchanged — the additions are additive.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/research/corpus-gates.ts packages/longwrite/tests/corpus-gates-observations.test.ts
git commit -m "feat(research): emit numeric observations from the corpus gates"
```

---

### Task 13: Full verification and plan handoff

**Files:**
- Modify: `packages/longwrite/README.md` (document `longwrite metrics evaluate` and the registry module)

- [ ] **Step 1: Run the full workspace gate**

Run:
```bash
npm run build --workspace @mr-maliang/longwrite
npm test --workspace @mr-maliang/longwrite
```
Expected: build succeeds; all tests pass, including `routing-coverage`.

- [ ] **Step 2: Confirm the coverage test actually bites**

Temporarily add `route("style_drift", "corpus", "upgrade_source_quality", "revise_sections")` to `ROUTES` and re-run:

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: FAIL — `style_drift` is manuscript-class but the emitted-vs-routed check now reports a mismatch in kind coverage. Remove the temporary route and re-run to confirm PASS. A coverage test that cannot fail is not protecting anything.

- [ ] **Step 3: Document the new surface**

Add to `packages/longwrite/README.md` under the metrics section:

```markdown
### Acceptance metrics

`longwrite metrics evaluate <workspace> [--tier unit|round|release]` measures
acceptance metrics and appends immutable observations under
`.malaclaw/observations/`. An observation is reused when its input and
evaluator digests are unchanged, so a `release`-tier metric is not recomputed
after an unrelated repair. Metrics whose measurement pipeline is `model` or
`external` are produced by their own measurement units and are reported as
skipped here — a mutation unit never writes the number that grades it.
```

- [ ] **Step 4: Run the repository release check**

Run: `npm run build && npm test`
Expected: PASS across the monorepo. `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/README.md
git commit -m "docs(longwrite): document the metric registry and metrics evaluate command"
```

---

## Plan Self-Review

**Spec coverage.** §A1 structured observations → Tasks 5, 12. §A2 metric registry, measurement pipelines, tiers, invalidation → Tasks 6, 7, 10. §A3 structured findings, artifact kinds, required effects → Tasks 1, 5, 11. §A3a producer map → Task 3 routes. §A3b gate classes and generated coverage → Tasks 2, 4. §A4 fail-closed routing → Task 3. §B4 measurement scheduling and invalidation → Tasks 6, 10. §B6 objective identity including scope → Task 8. §B11 digest-and-sequence freshness → Task 7.

Deliberately **not** covered here, and assigned onward: §A5 target reservation, §A6 repair packets, §A7 registry-rendered prompts, and §A8 the diagnosis unit go to **Plan 3**; the entire Part B kernel — execution roles, effects enforcement, typed outcomes, attempt lifecycle, leases, concurrency, pinning, blockers — goes to **Plan 2**. Task 8 implements the *acceptance arithmetic* only; the kernel that calls it is Plan 2's.

**Type consistency.** `EvaluatorFn` is defined in Task 9 and imported in Task 10. `evaluatorDigest` is introduced in Task 10 and Task 12 requires it exported — Task 10's implementation must export it. `StructuredCheck` from Task 5 is the return type adopted in Task 11. `MetricDefinition` from Task 6 is the parameter type in Task 7's `computeInputDigest`. `Criterion` in Task 8 uses `MetricId` from Task 1.

**Known ordering constraint.** Task 12 depends on Task 10 exporting `evaluatorDigest`; if executed out of order, add the export first.
