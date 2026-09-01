# Contract Core, Plan 1: Registries and Structured Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MrMaLiang's deterministic gates emit structured findings and numeric observations instead of prose, behind closed registries that a triple-level coverage test enforces.

**Architecture:** Gates already compute both the routing triple (artifact, kind, effect) and the numeric observation (value, target), then flatten both into `string` and discard them. This plan adds `src/lib/registry/` — branded ids, explicit producer registration, the legal-triple and routing tables, the metric registry, and a content-addressed observation store — then converts the gate producers. No MalaClaw change and no workflow-topology change.

**Tech Stack:** TypeScript (ESM, Node 22+), Zod 3, Vitest 4, existing `longwrite` Commander CLI.

**Spec:** `docs/superpowers/specs/2026-08-31-contract-enforcement-core-design.md` — §A1, §A2, §A3, §A3a, §A3b, §A4.

**Explicitly out of scope, and why:**
- **§A9 (model tiering)** is a compiler concern; it lands in Plan 3 Task 8 with the IR v2 units. This plan does not claim it.
- **§B4 (measurement scheduling)** is only *partly* here: this plan defines dependency-driven invalidation and reuse. Deferred measurement, `pending_verification`, and round scheduling are kernel behavior and belong to Plan 2.
- **§A5 to §A8** are Plan 3.

## Global Constraints

- Node.js 22 or newer. ESM; **relative imports carry the `.js` extension** in `.ts` files.
- Zod schemas are `.strict()`. Malformed durable state **throws**; it is never silently skipped, because a skipped record becomes a trusted wrong number.
- Registries are the single source of truth. Never restate registry content in a prompt — Plan 3 renders prompts from these registries.
- Routing fails closed. No default route. An unresolved triple is an error.
- Never order or compare observations by wall-clock time, and never select an observation without first matching its dependency and evaluator digests.
- **Reuse the canonical helpers.** `citedSourceIds`, `isAcceptedSource`, and `isArxivOnlySource` already exist in `src/lib/validation/research.ts`. A second implementation of any of them is a defect, not an evaluator.
- Every measurement is reproducible from its inputs. Anything time-dependent takes an explicit `evaluation_as_of_date` that enters the digest.
- Sequence numbers are allocated atomically or supplied by the caller. A read-then-increment is a race and is not acceptable.
- MalaClaw gains nothing in this plan.
- Tests: `npm test --workspace @mr-maliang/longwrite`. Fixtures use `fs.mkdtemp` under `os.tmpdir()`, removed in `afterEach`, following `tests/corpus-gates.test.ts`.
- Preserve the dirty worktree. Only touch files named in a task.

---

### Task 1: Branded ids, closed vocabularies, and gate families

Gate ids are not all static literals: `corpus-gates.ts:93` emits a template-literal id of the form `taxonomy:<cell>`, which contains a colon and is generated at runtime. A registry that assumes plain lowercase literals cannot represent it, and a scanner looking for a quoted `id:` cannot see it.

**Files:**
- Create: `packages/longwrite/src/lib/registry/ids.ts`
- Test: `packages/longwrite/tests/registry-ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: types `GateId`, `MetricId`, `CapabilityId`; `ARTIFACT_KINDS`/`ArtifactKind`, `REQUIRED_EFFECTS`/`RequiredEffect`, `GATE_CLASSES`/`GateClass`; constructors `gateId`, `metricId`, `capabilityId`; schemas `GateIdSchema`, `MetricIdSchema`, `ArtifactKindSchema`, `RequiredEffectSchema`; `gateFamily(id: GateId): GateId` mapping a parameterized id to its family; `isParameterized(id: GateId): boolean`; `EDITABLE_KIND_PATHS`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KINDS, REQUIRED_EFFECTS, GATE_CLASSES,
  ArtifactKindSchema, RequiredEffectSchema, GateIdSchema,
  gateId, metricId, gateFamily, isParameterized, EDITABLE_KIND_PATHS,
} from "../src/lib/registry/ids.js";

describe("registry ids", () => {
  it("exposes the closed artifact-kind vocabulary", () => {
    expect(ARTIFACT_KINDS).toContain("chapter_prose");
    expect(ARTIFACT_KINDS).toContain("latex_layout");
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

  it("rejects values outside a closed vocabulary", () => {
    expect(ArtifactKindSchema.safeParse("prose").success).toBe(false);
    expect(RequiredEffectSchema.safeParse("make_it_better").success).toBe(false);
  });

  it("accepts a parameterized gate id and resolves its family", () => {
    expect(GateIdSchema.safeParse("taxonomy:agent_memory").success).toBe(true);
    expect(gateFamily(gateId("taxonomy:agent_memory"))).toBe("taxonomy");
    expect(isParameterized(gateId("taxonomy:agent_memory"))).toBe(true);
  });

  it("treats a plain gate id as its own family", () => {
    expect(gateFamily(gateId("figure_references"))).toBe("figure_references");
    expect(isParameterized(gateId("figure_references"))).toBe(false);
  });

  it("rejects a malformed identifier and a multi-segment parameter", () => {
    expect(GateIdSchema.safeParse("Figure References").success).toBe(false);
    expect(GateIdSchema.safeParse("taxonomy:a:b").success).toBe(false);
    expect(() => gateId("Figure References")).toThrow();
  });

  it("records generated kinds as having no editable path of their own", () => {
    expect(EDITABLE_KIND_PATHS.latex_layout).toEqual([]);
    expect(EDITABLE_KIND_PATHS.figure_spec).toContain("figures/placement-plan.json");
  });

  it("keeps gate and metric ids as distinct brands", () => {
    expect(String(gateId("rendered_visual_review"))).toBe(String(metricId("rendered_visual_review")));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-ids`
Expected: FAIL — cannot resolve `../src/lib/registry/ids.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/ids.ts`:

```ts
import { z } from "zod";

const SEGMENT = "[a-z][a-z0-9_]*";
/** A gate id is a family, optionally followed by one parameter segment. The
 * parameterized form exists because corpus-gates emits one gate per taxonomy
 * cell at runtime; pretending every gate id is a static literal is what made
 * the first inventory of this registry wrong. */
const GATE_ID = new RegExp("^" + SEGMENT + "(:" + SEGMENT + ")?$");
const PLAIN_ID = new RegExp("^" + SEGMENT + "$");

declare const gateBrand: unique symbol;
declare const metricBrand: unique symbol;
declare const capabilityBrand: unique symbol;

export type GateId = string & { readonly [gateBrand]: true };
export type MetricId = string & { readonly [metricBrand]: true };
export type CapabilityId = string & { readonly [capabilityBrand]: true };

export const GateIdSchema = z.string().regex(GATE_ID).transform((value) => value as GateId);
export const MetricIdSchema = z.string().regex(PLAIN_ID).transform((value) => value as MetricId);
export const CapabilityIdSchema = z.string().regex(PLAIN_ID).transform((value) => value as CapabilityId);

export function gateId(value: string): GateId { return GateIdSchema.parse(value); }
export function metricId(value: string): MetricId { return MetricIdSchema.parse(value); }
export function capabilityId(value: string): CapabilityId { return CapabilityIdSchema.parse(value); }

/** Registry lookups key on the family, so one entry covers every instance. */
export function gateFamily(id: GateId): GateId {
  return id.split(":")[0] as GateId;
}
export function isParameterized(id: GateId): boolean {
  return id.includes(":");
}

export const GATE_CLASSES = ["manuscript", "environment", "measurement"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];
export const GateClassSchema = z.enum(GATE_CLASSES);

export const ARTIFACT_KINDS = [
  "chapter_prose", "abstract", "outline",
  "figure_spec", "table_spec", "latex_layout", "bibliography",
  "source_record", "evidence_packet", "corpus", "experiment_manifest",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

export const REQUIRED_EFFECTS = [
  "add_explicit_artifact_reference", "add_supporting_citation", "remove_unsupported_claim",
  "repair_citation_marker", "replace_organizing_claim", "resolve_contradiction",
  "remove_redundant_prose", "repair_artifact_content", "repair_artifact_placement",
  "acquire_additional_evidence", "upgrade_source_quality", "repair_source_metadata",
  "repair_bibliography_consistency",
] as const;
export type RequiredEffect = (typeof REQUIRED_EFFECTS)[number];
export const RequiredEffectSchema = z.enum(REQUIRED_EFFECTS);

/** Editable path prefixes per artifact kind, used by Task 6 to validate that a
 * finding's declared kind matches the path it names. A generated kind has no
 * editable path of its own: a finding against generated TeX must name the
 * producing surface and put the TeX location in `location`. */
export const EDITABLE_KIND_PATHS: Record<ArtifactKind, readonly string[]> = {
  chapter_prose: ["chapters/"],
  abstract: ["paper/abstract.md"],
  outline: ["outline.md", "outline.json"],
  figure_spec: ["figures/placement-plan.json"],
  table_spec: ["figures/placement-plan.json"],
  latex_layout: [],
  bibliography: ["sources/bibliography.bib"],
  source_record: ["sources/classified_sources.jsonl"],
  evidence_packet: ["evidence/"],
  corpus: ["sources/"],
  experiment_manifest: [],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-ids`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/ids.ts packages/longwrite/tests/registry-ids.test.ts
git commit -m "feat(registry): add branded ids, closed vocabularies and parameterized gate families"
```

---

### Task 2: Explicit producer registration

A regex scan over source text cannot see a template-literal id, a helper-built id, or a single-quoted one, and it silently reports absence as coverage. Producers declare their gate ids instead.

**Files:**
- Create: `packages/longwrite/src/lib/registry/producers.ts`
- Modify: `packages/longwrite/src/lib/validation/research.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/validation/figures.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/validation/latex.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/validation/longform.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/research/corpus-gates.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/research/survey-contract.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/ops/visual-review.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/lib/publication.ts` (export `GATE_IDS`)
- Modify: `packages/longwrite/src/commands/preflight.ts` (export `GATE_IDS`)
- Test: `packages/longwrite/tests/registry-producers.test.ts`

**Interfaces:**
- Consumes: `GateId`, `gateId`, `gateFamily` (Task 1).
- Produces: each producer module exports `export const GATE_IDS: readonly string[]`. `producers.ts` exports `PRODUCERS: ReadonlyMap<string, readonly GateId[]>` and `allEmittedGateFamilies(): Set<GateId>`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-producers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRODUCERS, allEmittedGateFamilies } from "../src/lib/registry/producers.js";
import { gateId } from "../src/lib/registry/ids.js";

describe("producer registration", () => {
  it("registers every gate-producing module", () => {
    expect([...PRODUCERS.keys()].sort()).toEqual([
      "corpus-gates", "figures", "latex", "longform", "preflight",
      "publication", "research", "survey-contract", "visual-review",
    ]);
  });

  it("captures the parameterized taxonomy family a text scan cannot see", () => {
    expect(allEmittedGateFamilies().has(gateId("taxonomy"))).toBe(true);
  });

  it("captures the visual-review gates missed by a source scan", () => {
    const families = allEmittedGateFamilies();
    expect(families.has(gateId("rendered_visual_review"))).toBe(true);
    expect(families.has(gateId("visual_review_contract"))).toBe(true);
  });

  it("declares only the documented duplicate gate id", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [module, ids] of PRODUCERS) {
      for (const id of ids) {
        if (seen.has(id) && seen.get(id) !== module) duplicates.push(`${id} (${seen.get(id)} and ${module})`);
        seen.set(id, module);
      }
    }
    expect(duplicates.sort()).toEqual(["target_length (research and longform)"]);
  });

  it("declares only well-formed gate ids", () => {
    for (const ids of PRODUCERS.values()) {
      for (const id of ids) expect(() => gateId(String(id))).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-producers`
Expected: FAIL — cannot resolve `producers.js`.

- [ ] **Step 3: Write minimal implementation**

In each producer module, add an exported declaration adjacent to its checks. For `corpus-gates.ts`, the taxonomy family is declared once rather than per cell:

```ts
/** Gate ids this module emits. Declared rather than scanned: the taxonomy gate
 * id is built at runtime and no text scan can enumerate its instances. */
export const GATE_IDS = [
  "total_candidates", "core_sources", "freshness", "source_type_diversity", "taxonomy",
] as const;
```

For `figures.ts`:

```ts
export const GATE_IDS = [
  "figure_manifest", "full_mode_visual_contract", "figure_artifacts",
  "figure_references", "publication_layout", "diagram_connectivity",
] as const;
```

Declare the equivalent constant in each of the other seven modules, listing exactly the ids that module returns. Then create `packages/longwrite/src/lib/registry/producers.ts`:

```ts
import { gateId, gateFamily, type GateId } from "./ids.js";
import { GATE_IDS as research } from "../validation/research.js";
import { GATE_IDS as figures } from "../validation/figures.js";
import { GATE_IDS as latex } from "../validation/latex.js";
import { GATE_IDS as longform } from "../validation/longform.js";
import { GATE_IDS as corpusGates } from "../research/corpus-gates.js";
import { GATE_IDS as surveyContract } from "../research/survey-contract.js";
import { GATE_IDS as visualReview } from "../ops/visual-review.js";
import { GATE_IDS as publication } from "../publication.js";
import { GATE_IDS as preflight } from "../../commands/preflight.js";

const MODULES: Array<[string, readonly string[]]> = [
  ["research", research], ["figures", figures], ["latex", latex], ["longform", longform],
  ["corpus-gates", corpusGates], ["survey-contract", surveyContract],
  ["visual-review", visualReview], ["publication", publication], ["preflight", preflight],
];

/** The authoritative inventory. A module that emits a gate without declaring it
 * here fails tests/routing-coverage.test.ts. Declaration is the only mechanism
 * a dynamically built id cannot defeat. */
export const PRODUCERS: ReadonlyMap<string, readonly GateId[]> =
  new Map(MODULES.map(([name, ids]) => [name, ids.map(gateId)]));

export function allEmittedGateFamilies(): Set<GateId> {
  const families = new Set<GateId>();
  for (const ids of PRODUCERS.values()) for (const id of ids) families.add(gateFamily(id));
  return families;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-producers`
Expected: PASS, 5 tests. If the duplicate assertion fails, the message names the real duplicates — declare them explicitly rather than relaxing the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/producers.ts packages/longwrite/src/lib/validation/ packages/longwrite/src/lib/research/corpus-gates.ts packages/longwrite/src/lib/research/survey-contract.ts packages/longwrite/src/lib/ops/visual-review.ts packages/longwrite/src/lib/publication.ts packages/longwrite/src/commands/preflight.ts packages/longwrite/tests/registry-producers.test.ts
git commit -m "feat(registry): register gate ids at their producers instead of scanning source text"
```

---

### Task 3: Gate classes

**Files:**
- Create: `packages/longwrite/src/lib/registry/gate-classes.ts`
- Modify: `packages/longwrite/src/lib/validation/research.ts` (delete the `review_no_regressions` check and its `GATE_IDS` entry)
- Test: `packages/longwrite/tests/registry-gate-classes.test.ts`

**Interfaces:**
- Consumes: `GateId`, `GateClass`, `gateId`, `gateFamily` (Task 1); `allEmittedGateFamilies` (Task 2).
- Produces: `GATE_CLASS_TABLE: ReadonlyMap<GateId, GateClass>`; `gateClass(id: GateId): GateClass` (resolves the family, throws on unclassified); `gatesOfClass(cls): GateId[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-gate-classes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gateId } from "../src/lib/registry/ids.js";
import { gateClass, gatesOfClass, GATE_CLASS_TABLE } from "../src/lib/registry/gate-classes.js";
import { allEmittedGateFamilies } from "../src/lib/registry/producers.js";

describe("gate classes", () => {
  it("classifies manuscript defect gates", () => {
    expect(gateClass(gateId("figure_references"))).toBe("manuscript");
    expect(gateClass(gateId("core_sources"))).toBe("manuscript");
  });

  it("resolves a parameterized gate through its family", () => {
    expect(gateClass(gateId("taxonomy:agent_memory"))).toBe("manuscript");
  });

  it("classifies preflight preconditions as environment", () => {
    for (const id of ["pdf_compiler", "worker_runtime", "token_guardrail"]) {
      expect(gateClass(gateId(id))).toBe("environment");
    }
  });

  it("classifies full_claim_double_review as a measurement to re-run", () => {
    expect(gateClass(gateId("full_claim_double_review"))).toBe("measurement");
  });

  it("deletes review_no_regressions rather than reclassifying it", () => {
    expect(GATE_CLASS_TABLE.has(gateId("review_no_regressions"))).toBe(false);
    expect(allEmittedGateFamilies().has(gateId("review_no_regressions"))).toBe(false);
  });

  it("classifies empirical_experiment as environment, outside LongWrite's reach", () => {
    expect(gateClass(gateId("empirical_experiment"))).toBe("environment");
  });

  it("throws rather than defaulting for an unknown gate", () => {
    expect(() => gateClass(gateId("some_new_gate"))).toThrow(/unclassified gate/);
  });

  it("classifies every emitted family", () => {
    const unclassified = [...allEmittedGateFamilies()]
      .filter((id) => !GATE_CLASS_TABLE.has(id)).map(String).sort();
    expect(unclassified, `unclassified: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("has at least one gate in each class", () => {
    for (const cls of ["manuscript", "environment", "measurement"] as const) {
      expect(gatesOfClass(cls).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-gate-classes`
Expected: FAIL — cannot resolve `gate-classes.js`.

- [ ] **Step 3: Write minimal implementation**

First **delete** the `review_no_regressions` check from `src/lib/validation/research.ts` and remove it from that module's `GATE_IDS`. Spec 1 retires it: the invariant it approximated is now `must_preserve` in the kernel, and keeping a weaker duplicate would let a regression pass one check while failing the other.

Then create `packages/longwrite/src/lib/registry/gate-classes.ts`:

```ts
import { gateFamily, gateId, type GateClass, type GateId } from "./ids.js";

/** Preconditions of the run, and work outside LongWrite's reach. Neither is a
 * defect in the manuscript, so neither routes to a repair capability: a missing
 * LaTeX compiler is not fixed by editing prose, and an absent experiment
 * manifest is not fixed by any capability this product owns. */
const ENVIRONMENT = [
  "article_front_matter", "direct_llm_drafting", "draft_concurrency", "pdf_compiler",
  "public_release_urls", "publication_figure_renderer", "rendered_visual_review_tools",
  "rendered_visual_review_topology", "review_topology", "token_guardrail", "worker_runtime",
  "empirical_experiment",
];

/** Re-run, never repair. */
const MEASUREMENT = ["full_claim_double_review", "visual_review_contract"];

/** Defects in the artifact under construction. Every one needs complete
 * triple-level routing, enforced by tests/routing-coverage.test.ts. */
const MANUSCRIPT = [
  "bibliography_consistent", "chapter_outline_identity", "citation_evidence_ledger",
  "citation_markers_present", "citation_url_liveness", "citation_verification",
  "cited_literature_release_gates", "claim_contradictions", "claim_support",
  "codebase_evidence", "core_sources", "diagram_connectivity", "evidence_coverage",
  "figure_artifacts", "figure_manifest", "figure_references", "freshness",
  "full_mode_visual_contract", "full_research_contracts", "full_source_identity",
  "introduction_gap_contributions", "landmark_citation_coverage", "landmark_coverage",
  "latex_build", "latex_outline_structure", "latex_sources", "limitations_future_work",
  "literature_quality_score", "manuscript_build", "method_family_chapters",
  "multi_axis_taxonomy", "prose_redundancy", "publication_article_layout",
  "publication_artifact_contract", "publication_custom_template", "publication_figures",
  "publication_latex", "publication_layout", "publication_min_pages",
  "publication_page_limit", "publication_release_gates", "publication_required_sections",
  "reader_facing_publication", "related_work_differentiation", "related_work_matrix",
  "rendered_visual_review", "research_artifacts_present", "research_policy",
  "review_target", "section_evidence_requirements", "source_coverage",
  "source_type_diversity", "style_drift", "target_length", "taxonomy",
  "taxonomy_direct_evidence", "total_candidates",
];

function build(): ReadonlyMap<GateId, GateClass> {
  const table = new Map<GateId, GateClass>();
  for (const id of MANUSCRIPT) table.set(gateId(id), "manuscript");
  for (const id of ENVIRONMENT) table.set(gateId(id), "environment");
  for (const id of MEASUREMENT) table.set(gateId(id), "measurement");
  return table;
}
export const GATE_CLASS_TABLE = build();

export function gateClass(id: GateId): GateClass {
  const found = GATE_CLASS_TABLE.get(gateFamily(id));
  if (!found) throw new Error(`unclassified gate: ${id}. Add it to src/lib/registry/gate-classes.ts.`);
  return found;
}

export function gatesOfClass(cls: GateClass): GateId[] {
  return [...GATE_CLASS_TABLE.entries()].filter(([, value]) => value === cls).map(([key]) => key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-gate-classes`
Expected: PASS, 9 tests. The "classifies every emitted family" failure message names any gate still to add.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/gate-classes.ts packages/longwrite/src/lib/validation/research.ts packages/longwrite/tests/registry-gate-classes.test.ts
git commit -m "feat(registry): classify gates and delete review_no_regressions in favour of must_preserve"
```

---

### Task 4: Legal triples and the complete routing table

Coverage at gate level proves nothing: a gate can have one route and still emit findings whose triples are unroutable. Each manuscript gate therefore declares **every legal (kind, effect) pair it can emit**, and every pair must have a route. The two tables are written as one structure so a gate cannot acquire a triple without acquiring a route.

**Files:**
- Create: `packages/longwrite/src/lib/registry/routing.ts`
- Test: `packages/longwrite/tests/registry-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 ids; `gatesOfClass` (Task 3).
- Produces: `LEGAL_TRIPLES: ReadonlyMap<GateId, readonly Triple[]>`; `ROUTES: readonly RouteEntry[]`; `resolveCapability(key: RouteKey): CapabilityId` (throws `UnroutedFindingError`); `legalTriples(gate): readonly Triple[]`; `routedTripleKeys(): Set<string>`; `UnroutedFindingError`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gateId } from "../src/lib/registry/ids.js";
import {
  resolveCapability, UnroutedFindingError, LEGAL_TRIPLES, legalTriples, routedTripleKeys,
} from "../src/lib/registry/routing.js";
import { gatesOfClass } from "../src/lib/registry/gate-classes.js";

describe("fail-closed routing", () => {
  it("routes a prose-reference defect on a visual gate to the section editor", () => {
    expect(String(resolveCapability({
      gate: gateId("rendered_visual_review"), kind: "chapter_prose",
      effect: "add_explicit_artifact_reference",
    }))).toBe("revise_sections");
  });

  it("routes a figure-content defect on the same gate to the visual planner", () => {
    expect(String(resolveCapability({
      gate: gateId("rendered_visual_review"), kind: "figure_spec",
      effect: "repair_artifact_content",
    }))).toBe("revise_visual_plan");
  });

  it("routes a retrieval gate to research expansion, never to prose", () => {
    expect(String(resolveCapability({
      gate: gateId("core_sources"), kind: "corpus", effect: "acquire_additional_evidence",
    }))).toBe("targeted_research_expansion");
  });

  it("resolves a parameterized gate through its family", () => {
    expect(String(resolveCapability({
      gate: gateId("taxonomy:agent_memory"), kind: "corpus", effect: "acquire_additional_evidence",
    }))).toBe("targeted_research_expansion");
  });

  it("throws instead of defaulting when the triple is unrouted", () => {
    expect(() => resolveCapability({
      gate: gateId("core_sources"), kind: "chapter_prose", effect: "remove_redundant_prose",
    })).toThrow(UnroutedFindingError);
  });

  it("carries the unresolved key for the diagnosis unit", () => {
    try {
      resolveCapability({ gate: gateId("style_drift"), kind: "corpus", effect: "upgrade_source_quality" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as UnroutedFindingError).key.kind).toBe("corpus");
    }
  });

  it("declares legal triples for every manuscript gate", () => {
    const missing = gatesOfClass("manuscript").filter((gate) => !LEGAL_TRIPLES.has(gate)).map(String).sort();
    expect(missing, `manuscript gates with no declared triples: ${missing.join(", ")}`).toEqual([]);
  });

  it("routes every legal triple, not merely every gate", () => {
    const routed = routedTripleKeys();
    const unrouted: string[] = [];
    for (const gate of gatesOfClass("manuscript")) {
      for (const triple of legalTriples(gate)) {
        if (!routed.has(`${gate} ${triple.kind} ${triple.effect}`)) {
          unrouted.push(`${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unrouted.sort(), `unrouted: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("declares no route for a triple no gate can legally emit", () => {
    const legal = new Set<string>();
    for (const [gate, triples] of LEGAL_TRIPLES) {
      for (const triple of triples) legal.add(`${gate} ${triple.kind} ${triple.effect}`);
    }
    const extra = [...routedTripleKeys()].filter((key) => !legal.has(key)).sort();
    expect(extra, `routes for impossible triples: ${extra.join(", ")}`).toEqual([]);
  });

  it("declares no legal triple for a non-manuscript gate", () => {
    for (const cls of ["environment", "measurement"] as const) {
      for (const gate of gatesOfClass(cls)) expect(LEGAL_TRIPLES.has(gate)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-routing`
Expected: FAIL — cannot resolve `routing.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/routing.ts`. Every manuscript gate from Task 3 appears exactly once in `TABLE`:

```ts
import { capabilityId, gateFamily, gateId, type ArtifactKind, type CapabilityId, type GateId, type RequiredEffect } from "./ids.js";

export type RouteKey = { gate: GateId; kind: ArtifactKind; effect: RequiredEffect };
export type Triple = { kind: ArtifactKind; effect: RequiredEffect };
export type RouteEntry = RouteKey & { capability: CapabilityId };

export class UnroutedFindingError extends Error {
  constructor(readonly key: RouteKey) {
    super(`no capability owns (${key.gate}, ${key.kind}, ${key.effect}); add a route or reclassify the gate`);
    this.name = "UnroutedFindingError";
  }
}

const SECTIONS = "revise_sections";
const VISUAL = "revise_visual_plan";
const OUTLINE = "reopen_outline";
const EXPANSION = "targeted_research_expansion";
const SOURCE_META = "repair_source_metadata";
const BIB = "repair_bibliography";

/** gate -> legal (kind, effect) pairs -> owning capability.
 *
 * One table, so a legal triple cannot exist without a route. Several gates
 * legitimately emit findings owned by different capabilities; that is the case
 * gate-keyed routing could not express. */
const TABLE: Array<[string, Array<[ArtifactKind, RequiredEffect, string]>]> = [
  // Corpus and retrieval. A prose editor cannot acquire a source.
  ["total_candidates", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["core_sources", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["freshness", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["source_type_diversity", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["taxonomy", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["source_coverage", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["landmark_coverage", [["corpus", "acquire_additional_evidence", EXPANSION]]],
  ["literature_quality_score", [["corpus", "upgrade_source_quality", EXPANSION]]],
  ["research_policy", [["corpus", "upgrade_source_quality", EXPANSION]]],
  ["evidence_coverage", [
    ["corpus", "acquire_additional_evidence", EXPANSION],
    ["evidence_packet", "acquire_additional_evidence", EXPANSION],
  ]],
  ["taxonomy_direct_evidence", [
    ["evidence_packet", "acquire_additional_evidence", EXPANSION],
    ["chapter_prose", "add_supporting_citation", SECTIONS],
  ]],
  ["codebase_evidence", [["evidence_packet", "acquire_additional_evidence", EXPANSION]]],

  // Source records and bibliography. Nothing owned these before.
  ["citation_url_liveness", [["source_record", "repair_source_metadata", SOURCE_META]]],
  ["full_source_identity", [["source_record", "repair_source_metadata", SOURCE_META]]],
  ["bibliography_consistent", [["bibliography", "repair_bibliography_consistency", BIB]]],

  // Prose.
  ["landmark_citation_coverage", [["chapter_prose", "add_supporting_citation", SECTIONS]]],
  ["cited_literature_release_gates", [
    ["chapter_prose", "add_supporting_citation", SECTIONS],
    ["chapter_prose", "remove_unsupported_claim", SECTIONS],
    ["corpus", "upgrade_source_quality", EXPANSION],
  ]],
  ["citation_markers_present", [["chapter_prose", "repair_citation_marker", SECTIONS]]],
  ["citation_evidence_ledger", [["chapter_prose", "repair_citation_marker", SECTIONS]]],
  ["citation_verification", [["chapter_prose", "repair_citation_marker", SECTIONS]]],
  ["claim_support", [["chapter_prose", "remove_unsupported_claim", SECTIONS]]],
  ["claim_contradictions", [
    ["chapter_prose", "resolve_contradiction", SECTIONS],
    ["outline", "replace_organizing_claim", OUTLINE],
  ]],
  ["prose_redundancy", [["chapter_prose", "remove_redundant_prose", SECTIONS]]],
  ["target_length", [["chapter_prose", "remove_redundant_prose", SECTIONS]]],
  ["style_drift", [["chapter_prose", "remove_redundant_prose", SECTIONS]]],
  ["review_target", [
    ["chapter_prose", "remove_unsupported_claim", SECTIONS],
    ["figure_spec", "repair_artifact_content", VISUAL],
    ["outline", "replace_organizing_claim", OUTLINE],
  ]],

  // Structure.
  ["chapter_outline_identity", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["multi_axis_taxonomy", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["related_work_matrix", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["related_work_differentiation", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["method_family_chapters", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["section_evidence_requirements", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["introduction_gap_contributions", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["limitations_future_work", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["full_research_contracts", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["latex_outline_structure", [["outline", "replace_organizing_claim", OUTLINE]]],
  ["publication_required_sections", [["outline", "replace_organizing_claim", OUTLINE]]],

  // Visual artifacts. `latex_layout` is generated and never directly editable,
  // so these name the producing surface instead.
  ["figure_manifest", [["figure_spec", "repair_artifact_content", VISUAL]]],
  ["figure_artifacts", [["figure_spec", "repair_artifact_content", VISUAL]]],
  ["diagram_connectivity", [["figure_spec", "repair_artifact_content", VISUAL]]],
  ["figure_references", [
    ["figure_spec", "repair_artifact_placement", VISUAL],
    ["chapter_prose", "add_explicit_artifact_reference", SECTIONS],
  ]],
  ["full_mode_visual_contract", [
    ["figure_spec", "repair_artifact_content", VISUAL],
    ["table_spec", "repair_artifact_content", VISUAL],
  ]],
  ["rendered_visual_review", [
    ["chapter_prose", "add_explicit_artifact_reference", SECTIONS],
    ["figure_spec", "repair_artifact_content", VISUAL],
    ["figure_spec", "repair_artifact_placement", VISUAL],
    ["table_spec", "repair_artifact_content", VISUAL],
  ]],
  ["publication_layout", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["publication_figures", [["figure_spec", "repair_artifact_content", VISUAL]]],
  ["publication_latex", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["publication_article_layout", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["publication_custom_template", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["publication_release_gates", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["publication_artifact_contract", [["figure_spec", "repair_artifact_content", VISUAL]]],
  ["reader_facing_publication", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["research_artifacts_present", [["figure_spec", "repair_artifact_content", VISUAL]]],
  ["publication_min_pages", [["chapter_prose", "add_supporting_citation", SECTIONS]]],
  ["publication_page_limit", [["chapter_prose", "remove_redundant_prose", SECTIONS]]],

  // Build. Repaired through the producing surface, never by editing TeX.
  ["latex_build", [
    ["figure_spec", "repair_artifact_placement", VISUAL],
    ["bibliography", "repair_bibliography_consistency", BIB],
  ]],
  ["latex_sources", [["figure_spec", "repair_artifact_placement", VISUAL]]],
  ["manuscript_build", [["figure_spec", "repair_artifact_placement", VISUAL]]],
];

export const LEGAL_TRIPLES: ReadonlyMap<GateId, readonly Triple[]> = new Map(
  TABLE.map(([gate, rows]) => [gateId(gate), rows.map(([kind, effect]) => ({ kind, effect }))]),
);

export const ROUTES: readonly RouteEntry[] = TABLE.flatMap(([gate, rows]) =>
  rows.map(([kind, effect, capability]) => ({
    gate: gateId(gate), kind, effect, capability: capabilityId(capability),
  })));

function key(gate: GateId, kind: ArtifactKind, effect: RequiredEffect): string {
  return `${gate} ${kind} ${effect}`;
}

const INDEX = new Map<string, CapabilityId>(
  ROUTES.map((entry) => [key(entry.gate, entry.kind, entry.effect), entry.capability]));

export function legalTriples(gate: GateId): readonly Triple[] {
  return LEGAL_TRIPLES.get(gateFamily(gate)) ?? [];
}

export function routedTripleKeys(): Set<string> {
  return new Set(INDEX.keys());
}

/** No default. An unresolved triple escalates to diagnosis (Plan 3). */
export function resolveCapability(input: RouteKey): CapabilityId {
  const found = INDEX.get(key(gateFamily(input.gate), input.kind, input.effect));
  if (!found) throw new UnroutedFindingError(input);
  return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-routing`
Expected: PASS, 10 tests. Failures name the exact missing or impossible triples — fix the table, never the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/routing.ts packages/longwrite/tests/registry-routing.test.ts
git commit -m "feat(registry): declare legal triples and route every one of them, fail closed"
```

---

### Task 5: Triple-level coverage test in CI

**Files:**
- Create: `packages/longwrite/tests/routing-coverage.test.ts`

**Interfaces:**
- Consumes: `allEmittedGateFamilies` (Task 2); `GATE_CLASS_TABLE`, `gateClass`, `gatesOfClass` (Task 3); `LEGAL_TRIPLES`, `legalTriples`, `routedTripleKeys` (Task 4).

- [ ] **Step 1: Write the test**

Create `packages/longwrite/tests/routing-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allEmittedGateFamilies } from "../src/lib/registry/producers.js";
import { GATE_CLASS_TABLE, gateClass, gatesOfClass } from "../src/lib/registry/gate-classes.js";
import { LEGAL_TRIPLES, legalTriples, routedTripleKeys } from "../src/lib/registry/routing.js";

describe("routing coverage", () => {
  it("classifies every emitted gate family", () => {
    const unclassified = [...allEmittedGateFamilies()]
      .filter((id) => !GATE_CLASS_TABLE.has(id)).map(String).sort();
    expect(unclassified, `unclassified: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("emits every classified manuscript gate from some producer", () => {
    const emitted = allEmittedGateFamilies();
    const orphans = gatesOfClass("manuscript").filter((gate) => !emitted.has(gate)).map(String).sort();
    expect(orphans, `classified but never emitted: ${orphans.join(", ")}`).toEqual([]);
  });

  it("routes every legal triple of every manuscript gate", () => {
    const routed = routedTripleKeys();
    const unrouted: string[] = [];
    for (const gate of gatesOfClass("manuscript")) {
      const triples = legalTriples(gate);
      if (triples.length === 0) { unrouted.push(`${gate} (no legal triples declared)`); continue; }
      for (const triple of triples) {
        if (!routed.has(`${gate} ${triple.kind} ${triple.effect}`)) {
          unrouted.push(`${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unrouted.sort(), `unrouted: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("declares no route or triple for a non-manuscript gate", () => {
    for (const cls of ["environment", "measurement"] as const) {
      for (const gate of gatesOfClass(cls)) {
        expect(LEGAL_TRIPLES.has(gate), `${gate} is ${cls} but declares triples`).toBe(false);
      }
    }
  });

  it("resolves a manuscript class for every routed gate", () => {
    for (const gate of LEGAL_TRIPLES.keys()) expect(gateClass(gate)).toBe("manuscript");
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: PASS, 5 tests.

- [ ] **Step 3: Prove the test bites at triple level**

Temporarily append `["chapter_prose", "remove_redundant_prose", SECTIONS]` to the `core_sources` row of `TABLE`, then delete only that generated entry from `INDEX` by filtering it out of `ROUTES` before the index is built. Run:

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: FAIL, naming `core_sources/chapter_prose/remove_redundant_prose`.

Revert both edits and confirm PASS. A gate-level check passes this mutation, because `core_sources` already has a route — which is precisely why coverage compares triples.

- [ ] **Step 4: Commit**

```bash
git add packages/longwrite/tests/routing-coverage.test.ts
git commit -m "test(registry): enforce triple-level routing coverage in CI"
```

---

### Task 6: Structured finding and observation records

**Files:**
- Create: `packages/longwrite/src/lib/registry/records.ts`
- Test: `packages/longwrite/tests/registry-records.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas and `EDITABLE_KIND_PATHS`; `legalTriples` (Task 4).
- Produces: `FindingSchema`/`Finding`, `ObservationSchema`/`Observation`, `ModelJudgmentSchema`, `StructuredCheckSchema`/`StructuredCheck`.

The finding schema enforces Spec 1's trust rule: a declared `artifact.kind` must match the path it names. The observation schema carries §A2's uncertainty contract for model pipelines.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FindingSchema, ObservationSchema, StructuredCheckSchema } from "../src/lib/registry/records.js";

const finding = {
  id: "figure-1-missing-reference",
  gate_id: "rendered_visual_review",
  artifact: { kind: "chapter_prose", path: "chapters/section-03.md", artifact_id: "figure-1" },
  location: "paragraph preceding the placement of figure-1 in paper/sections/section-03.tex",
  required_effect: "add_explicit_artifact_reference",
  severity: "major",
  diagnostic: "Figure 1 is not named before its placement.",
};

const observation = {
  metric: "landmark_coverage_ratio",
  value: 0.083, target: 0.75, operator: "at_least",
  evaluator: "landmark_coverage_ratio",
  evaluator_digest: "a".repeat(64),
  input_digest: "b".repeat(64),
  sequence: 12,
  measured_at: "2026-09-01T00:00:00.000Z",
};

describe("structured records", () => {
  it("accepts a well-formed finding", () => {
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("rejects an effect outside the vocabulary and an unknown extra field", () => {
    expect(FindingSchema.safeParse({ ...finding, required_effect: "make_it_better" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding, hint: "try harder" }).success).toBe(false);
  });

  it("rejects a kind that does not match the path it names", () => {
    // A generated TeX path is not a figure spec. The producing surface must be
    // named instead, with the TeX location carried in `location`.
    const mismatched = { ...finding, artifact: { kind: "figure_spec", path: "paper/sections/section-03.tex" } };
    expect(FindingSchema.safeParse(mismatched).success).toBe(false);
  });

  it("rejects a finding whose triple its gate cannot legally emit", () => {
    const illegal = { ...finding, gate_id: "core_sources" };
    expect(FindingSchema.safeParse(illegal).success).toBe(false);
  });

  it("accepts a script observation without judgment fields", () => {
    expect(ObservationSchema.safeParse(observation).success).toBe(true);
  });

  it("requires a sequence so freshness never resolves by clock", () => {
    const { sequence, ...withoutSequence } = observation;
    expect(ObservationSchema.safeParse(withoutSequence).success).toBe(false);
  });

  it("carries the uncertainty contract on a model observation", () => {
    const judged = {
      ...observation, metric: "review_score", value: 7.8, evaluator: "review_score",
      judgment: {
        reasons: ["comparative synthesis is thin in section 4"],
        confidence: 0.62,
        rubric_version: "2",
        evidence_refs: ["reviews/scorecard.json#persona/theorist"],
        adjudicated: false,
        disagreement: "none",
      },
    };
    expect(ObservationSchema.safeParse(judged).success).toBe(true);
  });

  it("rejects a judgment missing its rubric version", () => {
    const judged = {
      ...observation, judgment: { reasons: ["x"], confidence: 0.5, evidence_refs: [], adjudicated: false, disagreement: "none" },
    };
    expect(ObservationSchema.safeParse(judged).success).toBe(false);
  });

  it("rejects a confidence outside zero to one", () => {
    const judged = {
      ...observation,
      judgment: { reasons: ["x"], confidence: 1.4, rubric_version: "2", evidence_refs: [], adjudicated: false, disagreement: "none" },
    };
    expect(ObservationSchema.safeParse(judged).success).toBe(false);
  });

  it("keeps prose only as an unparsed diagnostic on the check", () => {
    expect(StructuredCheckSchema.safeParse({
      id: "rendered_visual_review", pass: false,
      observations: [observation], findings: [finding],
      diagnostic: "1 of 12 landmark works are cited.",
    }).success).toBe(true);
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
import {
  ArtifactKindSchema, EDITABLE_KIND_PATHS, GateIdSchema, MetricIdSchema, RequiredEffectSchema,
  type ArtifactKind,
} from "./ids.js";
import { legalTriples } from "./routing.js";

function pathMatchesKind(kind: ArtifactKind, filePath: string): boolean {
  const prefixes = EDITABLE_KIND_PATHS[kind];
  // A generated kind has no editable path; a finding may never claim one.
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) => prefix.endsWith("/") ? filePath.startsWith(prefix) : filePath === prefix);
}

/** A defect, carrying everything the router needs, emitted by the gate that
 * found it. Two rules make it trustworthy without an LLM in the loop: the kind
 * must match the path, and the triple must be one its gate can legally emit. */
export const FindingSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  gate_id: GateIdSchema,
  artifact: z.object({
    kind: ArtifactKindSchema,
    path: z.string().min(1),
    artifact_id: z.string().min(1).optional(),
  }).strict(),
  /** Where the defect shows, including a generated location such as a TeX
   * line. This is the field a generated-artifact defect uses, because the
   * artifact itself must name the producing surface. */
  location: z.string().min(1).max(400).optional(),
  required_effect: RequiredEffectSchema,
  severity: z.enum(["minor", "major", "critical"]),
  /** For operators. Never parsed, never routed on. */
  diagnostic: z.string().min(1).max(8_000),
}).strict().superRefine((finding, ctx) => {
  if (!pathMatchesKind(finding.artifact.kind, finding.artifact.path)) {
    ctx.addIssue({
      code: "custom", path: ["artifact", "path"],
      message: `path ${finding.artifact.path} is not an editable ${finding.artifact.kind}; name the producing surface and put the generated location in \`location\``,
    });
  }
  const legal = legalTriples(finding.gate_id);
  if (!legal.some((triple) => triple.kind === finding.artifact.kind && triple.effect === finding.required_effect)) {
    ctx.addIssue({
      code: "custom", path: ["required_effect"],
      message: `${finding.gate_id} cannot legally emit (${finding.artifact.kind}, ${finding.required_effect}); declare the triple in routing.ts or fix the finding`,
    });
  }
});
export type Finding = z.infer<typeof FindingSchema>;

/** Spec 1 §A2: a model measurement is trusted because its acquisition,
 * validation and reduction are recorded — not because it is deterministic. */
export const ModelJudgmentSchema = z.object({
  reasons: z.array(z.string().min(1)).max(50),
  confidence: z.number().min(0).max(1),
  rubric_version: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).max(200),
  adjudicated: z.boolean(),
  disagreement: z.enum(["none", "within_tolerance", "material", "unresolved"]),
}).strict();

export const ObservationSchema = z.object({
  metric: MetricIdSchema,
  value: z.number().finite(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  evaluator: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  /** Implementation plus configuration version. */
  evaluator_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Declared dependencies, registry config, and for model pipelines the
   * prompt and model configuration. Never the producer's own output. */
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Monotonic engine sequence. Freshness resolves on this after digests
   * match, never on the clock. */
  sequence: z.number().int().nonnegative(),
  /** Provenance only. Never used for ordering. */
  measured_at: z.string().datetime(),
  /** Required for measurement_kind model; absent for script pipelines. */
  judgment: ModelJudgmentSchema.optional(),
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
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/records.ts packages/longwrite/tests/registry-records.test.ts
git commit -m "feat(registry): add structured findings with kind/path validation and model-judgment fields"
```

---

### Task 7: Metric registry with dependencies separated from producer output

`requires` conflated two different things. A metric's *dependencies* determine its digest and invalidation; a model pipeline's *raw output* is what the producer writes, and including it in the digest would make the measurement's identity depend on its own result.

**Files:**
- Create: `packages/longwrite/src/lib/registry/metrics.ts`
- Test: `packages/longwrite/tests/registry-metrics.test.ts`

**Interfaces:**
- Consumes: Task 1 ids.
- Produces: type `MetricDefinition`; `METRIC_REGISTRY: ReadonlyMap<MetricId, MetricDefinition>`; `PLANNER_SELECTABLE: ReadonlySet<MetricId>`; `metricDefinition(id): MetricDefinition` (throws); `metricsInvalidatedBy(changed: string[]): MetricId[]`; `metricsOfTier(tier): MetricId[]`.

`MetricDefinition` fields: `metric`, `direction`, `target_type`, `tolerance`, `measurement_tier`, `measurement_kind`, `evaluator`, `producer?`, `validator?`, `reducer`, `dependencies: string[]`, `raw_output: string[]`, `estimated_cost`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import {
  METRIC_REGISTRY, PLANNER_SELECTABLE, metricDefinition, metricsInvalidatedBy, metricsOfTier,
} from "../src/lib/registry/metrics.js";

describe("metric registry", () => {
  it("registers every observable metric, not only planner-selectable ones", () => {
    // Corpus gates observe candidate_count and friends; they are real metrics
    // even though a planner may not name them in an acceptance criterion.
    for (const id of ["candidate_count", "recent_source_ratio", "source_type_diversity_count"]) {
      expect(METRIC_REGISTRY.has(metricId(id)), `${id} is unregistered`).toBe(true);
    }
    expect(METRIC_REGISTRY.size).toBeGreaterThan(22);
  });

  it("allows the planner to select exactly the 22 acceptance metrics", () => {
    expect(PLANNER_SELECTABLE.size).toBe(22);
    expect(PLANNER_SELECTABLE.has(metricId("core_sources"))).toBe(true);
    expect(PLANNER_SELECTABLE.has(metricId("candidate_count"))).toBe(false);
  });

  it("keeps every planner-selectable metric registered", () => {
    for (const id of PLANNER_SELECTABLE) expect(METRIC_REGISTRY.has(id)).toBe(true);
  });

  it("marks the three expensive metrics as release tier", () => {
    for (const id of ["rendered_visual_review", "review_score", "claim_support"]) {
      expect(metricDefinition(metricId(id)).measurement_tier).toBe("release");
    }
  });

  it("declares producer, validator and reducer for every model pipeline", () => {
    for (const definition of METRIC_REGISTRY.values()) {
      if (definition.measurement_kind !== "model") continue;
      expect(definition.producer, `${definition.metric} has no producer`).toBeTruthy();
      expect(definition.validator, `${definition.metric} has no validator`).toBeTruthy();
      expect(definition.reducer, `${definition.metric} has no reducer`).toBeTruthy();
    }
  });

  it("never lists a producer's own output as a dependency", () => {
    // reviews/scorecard.json is what persona_review writes; including it in the
    // digest would make the measurement's identity depend on its own result.
    for (const definition of METRIC_REGISTRY.values()) {
      for (const output of definition.raw_output) {
        expect(definition.dependencies, `${definition.metric} depends on its own output`)
          .not.toContain(output);
      }
    }
  });

  it("includes chapters in the dependencies of every cited-source metric", () => {
    // These count sources cited in chapter prose; a chapter edit must
    // invalidate them, and only `dependencies` enters the digest.
    for (const id of ["cited_sources", "cited_within_one_year_ratio",
                      "accepted_cited_ratio", "cited_arxiv_only_ratio"]) {
      expect(metricDefinition(metricId(id)).dependencies.some((d) => d.startsWith("chapters/")),
        `${id} omits chapters`).toBe(true);
    }
  });

  it("includes validated evidence in landmark coverage dependencies", () => {
    expect(metricDefinition(metricId("landmark_coverage_ratio")).dependencies)
      .toContain("evidence/active-validated-source-evidence.json");
  });

  it("includes the config file where a metric reads configured targets", () => {
    expect(metricDefinition(metricId("taxonomy_cell_ab_sources")).dependencies)
      .toContain("longwrite.yaml");
  });

  it("records direction and tolerance so progress can be normalized", () => {
    expect(metricDefinition(metricId("prose_redundancy")).direction).toBe("minimize");
    expect(metricDefinition(metricId("core_sources")).direction).toBe("maximize");
    expect(metricDefinition(metricId("core_sources")).tolerance).toBe(0);
    expect(metricDefinition(metricId("landmark_coverage_ratio")).tolerance).toBeGreaterThan(0);
  });

  it("selects only the metrics a change invalidates", () => {
    const invalidated = metricsInvalidatedBy(["chapters/section-03.md"]).map(String);
    expect(invalidated).toContain("prose_redundancy");
    expect(invalidated).toContain("cited_sources");
    expect(invalidated).not.toContain("candidate_count");
  });

  it("lists metrics by tier", () => {
    expect(metricsOfTier("release").map(String).sort())
      .toEqual(["claim_support", "rendered_visual_review", "review_score"]);
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

Create `packages/longwrite/src/lib/registry/metrics.ts`. Register every observable metric; mark the 22 planner-selectable ones. The full acceptance list is in `src/lib/ops/action-plan.ts`; `claim_support` is canonical and the written key `claim_support_rate` is retired.

```ts
import { metricId, type MetricId } from "./ids.js";

export type MetricDefinition = {
  metric: MetricId;
  direction: "maximize" | "minimize";
  target_type: "ratio" | "count" | "boolean" | "score";
  /** Comparison tolerance. Zero for integer counts and booleans; small and
   * positive for ratios and scores, where exact float equality is wrong. */
  tolerance: number;
  measurement_tier: "unit" | "round" | "release";
  measurement_kind: "script" | "model" | "external";
  evaluator: string;
  producer?: string;
  validator?: string;
  reducer: string;
  /** Inputs whose change invalidates the measurement. Drives the input digest
   * and reuse. Never contains a producer's own output. */
  dependencies: string[];
  /** What a model or external producer writes, validated and reduced. Excluded
   * from the digest by construction. */
  raw_output: string[];
  estimated_cost: { model_calls: number; render_required: boolean };
};

const CHAPTERS = "chapters/";
const SOURCES = "sources/classified_sources.jsonl";
const CONFIG = "longwrite.yaml";
const VALIDATED_EVIDENCE = "evidence/active-validated-source-evidence.json";
const PACKETS = "evidence/";
const FIGURE_MANIFEST = "figures/manifest.json";
const PLACEMENT = "figures/placement-plan.json";
const LANDMARKS = "research/landmark-candidates.json";

function script(
  metric: string,
  direction: MetricDefinition["direction"],
  target_type: MetricDefinition["target_type"],
  tier: MetricDefinition["measurement_tier"],
  dependencies: string[],
): MetricDefinition {
  return {
    metric: metricId(metric), direction, target_type,
    tolerance: target_type === "count" || target_type === "boolean" ? 0 : 1e-6,
    measurement_tier: tier, measurement_kind: "script",
    evaluator: metric, reducer: `deterministic_${metric}`,
    dependencies, raw_output: [],
    estimated_cost: { model_calls: 0, render_required: false },
  };
}

const DEFINITIONS: MetricDefinition[] = [
  // --- Corpus observations. Registered normally; not planner-selectable.
  script("candidate_count", "maximize", "count", "unit", [SOURCES, CONFIG]),
  script("recent_source_ratio", "maximize", "ratio", "unit", [SOURCES, CONFIG]),
  script("source_type_diversity_count", "maximize", "count", "unit", [SOURCES, CONFIG]),

  // --- Corpus and citation acceptance metrics.
  script("core_sources", "maximize", "count", "unit", [SOURCES, CONFIG]),
  script("cited_sources", "maximize", "count", "unit", [CHAPTERS, SOURCES, PACKETS]),
  script("cited_within_one_year_ratio", "maximize", "ratio", "unit", [CHAPTERS, SOURCES, CONFIG]),
  script("accepted_cited_ratio", "maximize", "ratio", "unit", [CHAPTERS, SOURCES]),
  script("cited_arxiv_only_ratio", "minimize", "ratio", "unit", [CHAPTERS, SOURCES]),
  script("citation_depth_per_section", "maximize", "count", "unit", [CHAPTERS, SOURCES, PACKETS]),
  script("taxonomy_cell_ab_sources", "maximize", "count", "unit", [SOURCES, CONFIG]),
  script("landmark_coverage_ratio", "maximize", "ratio", "unit", [LANDMARKS, SOURCES, VALIDATED_EVIDENCE]),
  script("landmark_citation_coverage_ratio", "maximize", "ratio", "unit", [LANDMARKS, CHAPTERS]),

  // --- Manuscript metrics.
  script("prose_redundancy", "minimize", "count", "unit", [CHAPTERS, CONFIG]),
  script("claim_contradictions", "minimize", "count", "round", [CHAPTERS, "reviews/claim-judgments.jsonl"]),
  script("outline_readiness", "maximize", "boolean", "unit", ["outline.json", "outline.md"]),

  // --- Artifact metrics.
  script("figures", "maximize", "count", "unit", [FIGURE_MANIFEST]),
  script("tables", "maximize", "count", "unit", [FIGURE_MANIFEST]),
  script("comparative_tables", "maximize", "count", "unit", [FIGURE_MANIFEST]),
  script("verified_metadata_plots", "maximize", "count", "unit", [FIGURE_MANIFEST]),
  script("diagram_connectivity", "minimize", "count", "unit", [PLACEMENT]),
  script("empirical_trials", "maximize", "count", "unit", ["experiments/results.json"]),

  // --- Page-dependent: needs a build, so it defers to the round boundary.
  {
    ...script("citations_per_page", "maximize", "ratio", "round", [CHAPTERS, "paper/", "build/manuscript.pdf"]),
    estimated_cost: { model_calls: 0, render_required: true },
  },

  // --- Model pipelines. `dependencies` are the manuscript inputs; `raw_output`
  //     is what the producer writes and is deliberately not a dependency.
  {
    metric: metricId("review_score"), direction: "maximize", target_type: "score", tolerance: 0.05,
    measurement_tier: "release", measurement_kind: "model",
    evaluator: "review_score", producer: "persona_review", validator: "scorecard_schema",
    reducer: "deterministic_review_score",
    dependencies: [CHAPTERS, "paper/", PLACEMENT],
    raw_output: ["reviews/scorecard.json"],
    estimated_cost: { model_calls: 5, render_required: false },
  },
  {
    metric: metricId("claim_support"), direction: "maximize", target_type: "ratio", tolerance: 1e-6,
    measurement_tier: "release", measurement_kind: "model",
    evaluator: "claim_support", producer: "claim_double_review", validator: "claim_judgment_schema",
    reducer: "deterministic_claim_support_rate",
    dependencies: [CHAPTERS, PACKETS],
    raw_output: ["reviews/claim-judgments.jsonl"],
    estimated_cost: { model_calls: 2, render_required: false },
  },
  {
    metric: metricId("rendered_visual_review"), direction: "maximize", target_type: "boolean", tolerance: 0,
    measurement_tier: "release", measurement_kind: "model",
    evaluator: "rendered_visual_review", producer: "multimodal_page_review", validator: "visual_qa_schema",
    reducer: "deterministic_visual_verdict",
    dependencies: [CHAPTERS, PLACEMENT, "paper/", "build/manuscript.pdf"],
    raw_output: ["reviews/visual-qa.json"],
    estimated_cost: { model_calls: 1, render_required: true },
  },
];

export const METRIC_REGISTRY: ReadonlyMap<MetricId, MetricDefinition> =
  new Map(DEFINITIONS.map((definition) => [definition.metric, definition]));

/** The metrics a planner may name in an acceptance criterion. A narrower set
 * than the registry: corpus observations are measurable but are not a
 * scholarly objective anyone should be asked to optimize directly. */
export const PLANNER_SELECTABLE: ReadonlySet<MetricId> = new Set([
  "cited_sources", "cited_within_one_year_ratio", "accepted_cited_ratio", "cited_arxiv_only_ratio",
  "citations_per_page", "citation_depth_per_section", "taxonomy_cell_ab_sources", "core_sources",
  "comparative_tables", "verified_metadata_plots", "figures", "tables", "rendered_visual_review",
  "empirical_trials", "outline_readiness", "review_score", "claim_support",
  "landmark_coverage_ratio", "landmark_citation_coverage_ratio", "claim_contradictions",
  "prose_redundancy", "diagram_connectivity",
].map(metricId));

export function metricDefinition(id: MetricId): MetricDefinition {
  const found = METRIC_REGISTRY.get(id);
  if (!found) throw new Error(`unknown metric: ${id}. Add it to src/lib/registry/metrics.ts.`);
  return found;
}

function matches(dependency: string, filePath: string): boolean {
  return dependency.endsWith("/") ? filePath.startsWith(dependency) : dependency === filePath;
}

/** Invalidation is derived from dependencies rather than declared separately,
 * so the two can never disagree. */
export function metricsInvalidatedBy(changed: string[]): MetricId[] {
  return [...METRIC_REGISTRY.values()]
    .filter((definition) => definition.dependencies.some((dep) => changed.some((file) => matches(dep, file))))
    .map((definition) => definition.metric);
}

export function metricsOfTier(tier: MetricDefinition["measurement_tier"]): MetricId[] {
  return [...METRIC_REGISTRY.values()]
    .filter((definition) => definition.measurement_tier === tier).map((definition) => definition.metric);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-metrics`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/metrics.ts packages/longwrite/tests/registry-metrics.test.ts
git commit -m "feat(registry): register every observable metric, separating dependencies from producer output"
```

---

### Task 8: Canonical hashing and the observation store

**Files:**
- Create: `packages/longwrite/src/lib/registry/canonical.ts`
- Create: `packages/longwrite/src/lib/registry/observations.ts`
- Test: `packages/longwrite/tests/registry-canonical.test.ts`
- Test: `packages/longwrite/tests/registry-observations.test.ts`

**Interfaces:**
- Consumes: `ObservationSchema`, `Observation` (Task 6); `MetricDefinition` (Task 7).
- Produces: `canonicalJson(value: unknown): string`; `computeInputDigest(workspaceDir, definition, extra?)`; `evaluatorDigest(name, version)`; `reserveSequence(workspaceDir, storePath)`; `appendObservation(workspaceDir, storePath, observation)`; `currentObservation(workspaceDir, storePath, metric, inputDigest, evaluatorDigest)`; `readAllObservations(workspaceDir, storePath)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/longwrite/tests/registry-canonical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/lib/registry/canonical.js";

describe("canonical json", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } }))
      .toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("preserves nested values rather than dropping them", () => {
    // JSON.stringify(value, keyArray) filters keys at EVERY depth, silently
    // discarding nested model configuration. This must not.
    const rendered = canonicalJson({ model: { name: "opus", params: { effort: "high" } } });
    expect(rendered).toContain("effort");
    expect(rendered).toContain("high");
  });

  it("preserves array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("distinguishes null, missing and empty", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: "" })).not.toBe(canonicalJson({ a: null }));
  });
});
```

Create `packages/longwrite/tests/registry-observations.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metricId } from "../src/lib/registry/ids.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import {
  appendObservation, computeInputDigest, currentObservation,
  readAllObservations, reserveSequence, STORE,
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
  await fs.writeFile(path.join(ws, "longwrite.yaml"), "version: 1\n", "utf-8");
  return ws;
}
function record(overrides: Record<string, unknown> = {}) {
  return {
    metric: "prose_redundancy", value: 0, evaluator: "prose_redundancy",
    evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
    sequence: 1, measured_at: new Date().toISOString(), ...overrides,
  } as never;
}

describe("observation store", () => {
  it("writes an immutable content-addressed record", async () => {
    const ws = await workspace();
    const written = await appendObservation(ws, STORE, record());
    expect(written).toContain(path.join(STORE, "prose_redundancy", "b".repeat(64), "a".repeat(64)));
    expect(path.basename(written)).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("refuses to overwrite a different record at the same address", async () => {
    const ws = await workspace();
    await appendObservation(ws, STORE, record({ value: 1 }));
    // Same metric, digests and sequence but a different value is a contradiction,
    // not an update: an immutable store must reject it rather than clobber.
    await expect(appendObservation(ws, STORE, record({ value: 2 }))).rejects.toThrow(/conflicting observation/);
  });

  it("accepts a byte-identical rewrite idempotently", async () => {
    const ws = await workspace();
    const first = await appendObservation(ws, STORE, record({ value: 1 }));
    const second = await appendObservation(ws, STORE, record({ value: 1 }));
    expect(second).toBe(first);
  });

  it("selects the current value only among matching digests", async () => {
    const ws = await workspace();
    // A -> B -> A. The stale B record has the higher sequence; selecting by
    // sequence alone would return it.
    await appendObservation(ws, STORE, record({ value: 3, input_digest: "b".repeat(64), sequence: 1 }));
    await appendObservation(ws, STORE, record({ value: 9, input_digest: "c".repeat(64), sequence: 2 }));
    const current = await currentObservation(ws, STORE, metricId("prose_redundancy"), "b".repeat(64), "a".repeat(64));
    expect(current?.value).toBe(3);
  });

  it("returns null when no observation matches the current digests", async () => {
    const ws = await workspace();
    await appendObservation(ws, STORE, record());
    expect(await currentObservation(ws, STORE, metricId("prose_redundancy"), "d".repeat(64), "a".repeat(64)))
      .toBeNull();
    expect(await currentObservation(ws, STORE, metricId("prose_redundancy"), "b".repeat(64), "e".repeat(64)))
      .toBeNull();
  });

  it("breaks ties by sequence among matching digests", async () => {
    const ws = await workspace();
    await appendObservation(ws, STORE, record({ value: 5, sequence: 4 }));
    await appendObservation(ws, STORE, record({ value: 6, sequence: 9 }));
    const current = await currentObservation(ws, STORE, metricId("prose_redundancy"), "b".repeat(64), "a".repeat(64));
    expect(current?.value).toBe(6);
  });

  it("throws on a malformed stored record rather than skipping it", async () => {
    const ws = await workspace();
    await appendObservation(ws, STORE, record());
    const dir = path.join(ws, STORE, "prose_redundancy", "b".repeat(64), "a".repeat(64));
    await fs.writeFile(path.join(dir, `${"f".repeat(64)}.json`), "{ not json", "utf-8");
    // A skipped record becomes a trusted wrong number.
    await expect(readAllObservations(ws, STORE)).rejects.toThrow(/malformed observation/);
  });

  it("changes the input digest when a declared dependency changes", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("prose_redundancy"));
    const before = await computeInputDigest(ws, definition);
    await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One, revised\n", "utf-8");
    expect(await computeInputDigest(ws, definition)).not.toBe(before);
  });

  it("distinguishes a missing dependency from an empty one", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("prose_redundancy"));
    await fs.rm(path.join(ws, "longwrite.yaml"));
    const missing = await computeInputDigest(ws, definition);
    await fs.writeFile(path.join(ws, "longwrite.yaml"), "", "utf-8");
    expect(await computeInputDigest(ws, definition)).not.toBe(missing);
  });

  it("includes nested model configuration in the digest", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("review_score"));
    const a = await computeInputDigest(ws, definition, { model: { name: "opus", effort: "high" } });
    const b = await computeInputDigest(ws, definition, { model: { name: "opus", effort: "low" } });
    expect(a).not.toBe(b);
  });

  it("allocates unique sequences under concurrency", async () => {
    const ws = await workspace();
    const claimed = await Promise.all(Array.from({ length: 25 }, () => reserveSequence(ws, STORE)));
    expect(new Set(claimed).size).toBe(25);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-canonical registry-observations`
Expected: FAIL — cannot resolve `canonical.js` and `observations.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/canonical.ts`:

```ts
/** Recursive canonical JSON: object keys sorted at every depth, array order
 * preserved.
 *
 * `JSON.stringify(value, keyArray)` is not this. Its second argument is a
 * replacer that filters keys at EVERY depth against one flat list, so a nested
 * model configuration silently loses fields the top level never mentioned — a
 * digest that ignores the very thing it is meant to bind. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}
```

Create `packages/longwrite/src/lib/registry/observations.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical.js";
import { ObservationSchema, type Observation } from "./records.js";
import type { MetricDefinition } from "./metrics.js";
import type { MetricId } from "./ids.js";

export const STORE = path.join(".malaclaw", "observations");
const SAFE_SEGMENT = /^[a-z][a-z0-9_]*$/;
const DIGEST = /^[0-9a-f]{64}$/;

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertSegment(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`unsafe ${label} for a store path: ${value}`);
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

/** Hashes a dependency, distinguishing missing from empty. Two states that
 * hash identically make an absent input look like a measured zero. */
async function digestOfDependency(workspaceDir: string, dependency: string): Promise<string> {
  const hash = crypto.createHash("sha256").update(dependency);
  const targets = dependency.endsWith("/")
    ? await filesUnder(path.join(workspaceDir, dependency))
    : [path.join(workspaceDir, dependency)];
  if (dependency.endsWith("/") && targets.length === 0) return hash.update("\x01absent-directory").digest("hex");
  for (const target of targets) {
    const bytes = await fs.readFile(target).catch(() => null);
    hash.update(path.relative(workspaceDir, target).split(path.sep).join("/"));
    if (bytes === null) hash.update("\x01absent");
    else hash.update("\x02present").update(bytes);
  }
  return hash.digest("hex");
}

/** Covers declared dependencies, the registry configuration, and — for a model
 * pipeline — the prompt and model configuration passed as `extra`. Never the
 * producer's `raw_output`: that would make the measurement's identity depend
 * on its own result. */
export async function computeInputDigest(
  workspaceDir: string, definition: MetricDefinition, extra?: Record<string, unknown>,
): Promise<string> {
  const parts = [
    definition.metric, definition.evaluator, definition.reducer,
    canonicalJson(definition.dependencies), canonicalJson(definition.producer ?? null),
    canonicalJson(definition.validator ?? null),
  ];
  for (const dependency of [...definition.dependencies].sort()) {
    parts.push(dependency, await digestOfDependency(workspaceDir, dependency));
  }
  if (extra) parts.push(canonicalJson(extra));
  return sha256(parts.join("\u0001"));
}

export function evaluatorDigest(name: string, version: string): string {
  return sha256(canonicalJson({ name, version }));
}

/** Atomic sequence allocation. A read-then-increment over the store races when
 * two evaluators run concurrently; an exclusive create cannot. */
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

/** Immutable and content-addressed: the filename is the digest of the record,
 * and writes use an exclusive create. A rename would silently replace an
 * existing record at the same address. */
export async function appendObservation(
  workspaceDir: string, storePath: string, observation: Observation,
): Promise<string> {
  const parsed = ObservationSchema.parse(observation);
  assertSegment("metric", parsed.metric, SAFE_SEGMENT);
  assertSegment("evaluator", parsed.evaluator, SAFE_SEGMENT);
  assertSegment("input digest", parsed.input_digest, DIGEST);
  assertSegment("evaluator digest", parsed.evaluator_digest, DIGEST);

  const body = `${canonicalJson(parsed)}\n`;
  const dir = path.join(workspaceDir, storePath, parsed.metric, parsed.input_digest, parsed.evaluator_digest);
  await fs.mkdir(dir, { recursive: true });
  const rel = path.join(storePath, parsed.metric, parsed.input_digest, parsed.evaluator_digest, `${sha256(body)}.json`);
  const target = path.join(workspaceDir, rel);
  try {
    const handle = await fs.open(target, "wx");
    try { await handle.writeFile(body, "utf-8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(target, "utf-8");
    if (existing !== body) throw new Error(`conflicting observation at ${rel}`);
  }
  // Two records that differ only in value land at different addresses, so a
  // contradiction at the same (metric, digests, sequence) is detectable.
  const siblings = await fs.readdir(dir);
  const conflicting: string[] = [];
  for (const name of siblings) {
    if (!name.endsWith(".json")) continue;
    const other = ObservationSchema.parse(JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")));
    if (other.sequence === parsed.sequence && other.value !== parsed.value) conflicting.push(name);
  }
  if (conflicting.length > 0) throw new Error(`conflicting observation at sequence ${parsed.sequence} in ${rel}`);
  return rel;
}

export async function readAllObservations(workspaceDir: string, storePath: string): Promise<Observation[]> {
  const records: Observation[] = [];
  for (const file of await filesUnder(path.join(workspaceDir, storePath))) {
    if (!file.endsWith(".json")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.readFile(file, "utf-8")); }
    catch { throw new Error(`malformed observation: ${path.relative(workspaceDir, file)} is not valid JSON`); }
    const result = ObservationSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`malformed observation: ${path.relative(workspaceDir, file)} — ${result.error.issues[0]?.message}`);
    }
    records.push(result.data);
  }
  return records;
}

/** Digests first, sequence second.
 *
 * Selecting by sequence alone is wrong whenever a workspace goes A -> B -> A:
 * the valid, reusable A observation has a LOWER sequence than the now-stale B
 * one, so the stale value would win. */
export async function currentObservation(
  workspaceDir: string, storePath: string,
  metric: MetricId, inputDigest: string, evaluatorDigestValue: string,
): Promise<Observation | null> {
  const matching = (await readAllObservations(workspaceDir, storePath)).filter((record) =>
    record.metric === metric
    && record.input_digest === inputDigest
    && record.evaluator_digest === evaluatorDigestValue);
  if (matching.length === 0) return null;
  return matching.reduce((best, record) => (record.sequence > best.sequence ? record : best));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-canonical registry-observations`
Expected: PASS, 4 + 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/canonical.ts packages/longwrite/src/lib/registry/observations.ts packages/longwrite/tests/registry-canonical.test.ts packages/longwrite/tests/registry-observations.test.ts
git commit -m "feat(registry): add canonical hashing and a content-addressed observation store"
```

---

### Task 9: Acceptance arithmetic with correct equals semantics

**Files:**
- Create: `packages/longwrite/src/lib/registry/acceptance.ts`
- Test: `packages/longwrite/tests/registry-acceptance.test.ts`

**Interfaces:**
- Consumes: `metricDefinition` (Task 7).
- Produces: `Criterion`; `ProgressPolicy`; `satisfies(criterion, value)`; `closedGapFraction(criterion, before, after)`; `evaluateProgress(criterion, policy, before, after)`; `objectiveKey(criterion, findingIds, artifactIds)`; `assertOperatorCompatible(criterion)`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-acceptance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import {
  closedGapFraction, evaluateProgress, objectiveKey, satisfies, assertOperatorCompatible,
} from "../src/lib/registry/acceptance.js";

const coverage = { metric: metricId("landmark_coverage_ratio"), operator: "at_least" as const, target: 0.75 };
const redundancy = { metric: metricId("prose_redundancy"), operator: "at_most" as const, target: 0 };
const exactFigures = { metric: metricId("figures"), operator: "equals" as const, target: 4 };
const exactRatio = { metric: metricId("accepted_cited_ratio"), operator: "equals" as const, target: 0.5 };
const policy = { min_absolute_delta: 0.01, min_gap_fraction: 0.2, max_attempts: 2 };

describe("acceptance arithmetic", () => {
  it("satisfies at_least at or above target and at_most at or below", () => {
    expect(satisfies(coverage, 0.75)).toBe(true);
    expect(satisfies(coverage, 0.74)).toBe(false);
    expect(satisfies(redundancy, 0)).toBe(true);
    expect(satisfies(redundancy, 1)).toBe(false);
  });

  it("satisfies equals within the metric's tolerance, not by float identity", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754; exact equality is the wrong test.
    expect(satisfies(exactRatio, 0.1 + 0.2 + 0.2)).toBe(true);
    expect(satisfies(exactFigures, 4)).toBe(true);
    expect(satisfies(exactFigures, 5)).toBe(false);
  });

  it("measures at_least progress against the remaining gap", () => {
    expect(closedGapFraction(coverage, 0.083, 0.25)).toBeCloseTo(0.25, 2);
  });

  it("inverts the gap calculation for at_most", () => {
    expect(closedGapFraction(redundancy, 10, 5)).toBeCloseTo(0.5, 5);
  });

  it("measures equals progress as closed distance when starting below target", () => {
    expect(closedGapFraction(exactFigures, 0, 2)).toBeCloseTo(0.5, 5);
  });

  it("measures equals progress as closed distance when starting above target", () => {
    // Treating equals like at_least reports this as negative progress, which
    // is backwards: moving 8 -> 6 against a target of 4 closes half the gap.
    expect(closedGapFraction(exactFigures, 8, 6)).toBeCloseTo(0.5, 5);
  });

  it("reports negative progress when an equals metric moves away from target", () => {
    expect(closedGapFraction(exactFigures, 3, 1)).toBeLessThan(0);
  });

  it("accepts when the target is reached", () => {
    expect(evaluateProgress(coverage, policy, 0.5, 0.8)).toBe("accepted");
    expect(evaluateProgress(exactFigures, policy, 2, 4)).toBe("accepted");
  });

  it("reports improved when both thresholds are met short of target", () => {
    expect(evaluateProgress(coverage, policy, 0.083, 0.25)).toBe("improved");
  });

  it("rejects a slow crawl that clears the absolute delta but not the gap fraction", () => {
    expect(evaluateProgress(coverage, policy, 0.083, 0.103)).toBe("unmet");
  });

  it("rejects movement below the absolute delta", () => {
    expect(evaluateProgress(coverage, policy, 0.745, 0.7455)).toBe("unmet");
  });

  it("rejects an equals metric that moved away from the target", () => {
    expect(evaluateProgress(exactFigures, policy, 3, 1)).toBe("unmet");
  });

  it("validates the operator against the metric's declared direction", () => {
    expect(() => assertOperatorCompatible(coverage)).not.toThrow();
    expect(() => assertOperatorCompatible(redundancy)).not.toThrow();
    // prose_redundancy minimizes; at_least would ask for more defects.
    expect(() => assertOperatorCompatible({
      metric: metricId("prose_redundancy"), operator: "at_least", target: 1,
    })).toThrow(/minimize/);
  });

  it("keys an objective by scope so one section cannot reset another", () => {
    const a = objectiveKey({ metric: metricId("citation_depth_per_section"), operator: "at_least", target: 1, scope: "section-03" }, ["f1"], ["chapters/section-03.md"]);
    const b = objectiveKey({ metric: metricId("citation_depth_per_section"), operator: "at_least", target: 1, scope: "section-06" }, ["f1"], ["chapters/section-06.md"]);
    expect(a).not.toBe(b);
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
import { canonicalJson } from "./canonical.js";
import { metricDefinition } from "./metrics.js";
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

/** An operator that fights the metric's direction is a contract error, caught
 * here rather than by a hand-maintained list of special cases. */
export function assertOperatorCompatible(criterion: Criterion): void {
  const direction = metricDefinition(criterion.metric).direction;
  if (direction === "maximize" && criterion.operator === "at_most") {
    throw new Error(`${criterion.metric} is maximize; at_most would cap an objective it should raise`);
  }
  if (direction === "minimize" && criterion.operator === "at_least") {
    throw new Error(`${criterion.metric} is minimize; at_least would demand more of a defect count`);
  }
}

export function satisfies(criterion: Criterion, value: number): boolean {
  const tolerance = metricDefinition(criterion.metric).tolerance;
  if (criterion.operator === "at_least") return value >= criterion.target - tolerance;
  if (criterion.operator === "at_most") return value <= criterion.target + tolerance;
  // Exact float equality is never the right test for a ratio or a score.
  return Math.abs(value - criterion.target) <= tolerance;
}

/** Fraction of the remaining distance to target that this attempt closed.
 *
 * A raw delta is the wrong unit: a small absolute threshold on a ratio metric
 * is satisfiable many times over, which is a legal slow crawl.
 *
 * `equals` is two-sided. Treating it like `at_least` reports movement in the
 * wrong direction whenever the value starts above the target, so it is
 * measured as closed *distance* instead. */
export function closedGapFraction(criterion: Criterion, before: number, after: number): number {
  if (criterion.operator === "equals") {
    const gap = Math.abs(criterion.target - before);
    if (gap === 0) return 1;
    return (gap - Math.abs(criterion.target - after)) / gap;
  }
  const gap = criterion.operator === "at_most" ? before - criterion.target : criterion.target - before;
  if (gap <= 0) return 1;
  const moved = criterion.operator === "at_most" ? before - after : after - before;
  return moved / gap;
}

function absoluteProgress(criterion: Criterion, before: number, after: number): number {
  if (criterion.operator === "equals") {
    return Math.abs(criterion.target - before) - Math.abs(criterion.target - after);
  }
  return criterion.operator === "at_most" ? before - after : after - before;
}

export function evaluateProgress(
  criterion: Criterion, policy: ProgressPolicy, before: number, after: number,
): "accepted" | "improved" | "unmet" {
  if (satisfies(criterion, after)) return "accepted";
  if (absoluteProgress(criterion, before, after) < policy.min_absolute_delta) return "unmet";
  if (closedGapFraction(criterion, before, after) < policy.min_gap_fraction) return "unmet";
  return "improved";
}

/** Objective identity includes scope, target and the artifacts involved.
 * Keyed on the metric alone, progress at one scope resets the stagnation
 * counter for every other scope. */
export function objectiveKey(criterion: Criterion, findingIds: string[], artifactIds: string[]): string {
  return crypto.createHash("sha256").update(canonicalJson({
    metric: criterion.metric, operator: criterion.operator, target: criterion.target,
    scope: criterion.scope ?? "", findings: [...findingIds].sort(), artifacts: [...artifactIds].sort(),
  })).digest("hex").slice(0, 32);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-acceptance`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/acceptance.ts packages/longwrite/tests/registry-acceptance.test.ts
git commit -m "feat(registry): correct equals progress and validate operators against metric direction"
```

---

### Task 10: Deterministic evaluators reusing the canonical helpers

**Files:**
- Modify: `packages/longwrite/src/lib/validation/research.ts` (export `citedSourceIds`, `isAcceptedSource`, `isArxivOnlySource`, `isWithinOneCalendarYear`)
- Create: `packages/longwrite/src/lib/registry/evaluators/corpus.ts`
- Test: `packages/longwrite/tests/registry-evaluators-corpus.test.ts`

**Interfaces:**
- Consumes: the four helpers above; `loadProjectConfig`; `sourceMatchesTaxonomy`.
- Produces: `type EvaluatorContext = { workspaceDir: string; asOfDate: string }`; `type EvaluatorFn = (ctx: EvaluatorContext) => Promise<number>`; `MeasurementUnavailable` error class; `CORPUS_EVALUATORS: Record<string, EvaluatorFn>` covering `candidate_count`, `core_sources`, `recent_source_ratio`, `source_type_diversity_count`, `cited_sources`, `cited_within_one_year_ratio`, `accepted_cited_ratio`, `cited_arxiv_only_ratio`, `taxonomy_cell_ab_sources`.

Formulas, all over `sources/classified_sources.jsonl` and `chapters/*.md`:
- `candidate_count` — total classified records.
- `core_sources` — records whose `citation_depth` is `A` or `B`.
- `recent_source_ratio` — records passing `isWithinOneCalendarYear` relative to `asOfDate`, over all records.
- `source_type_diversity_count` — distinct provider/identifier types.
- `cited_sources` — records whose id appears in `citedSourceIds(chapters)`.
- `cited_within_one_year_ratio` — of cited records, those passing `isWithinOneCalendarYear`.
- `accepted_cited_ratio` — of cited records, those passing `isAcceptedSource`.
- `cited_arxiv_only_ratio` — of cited records, those passing `isArxivOnlySource`. **Not** the complement of accepted.
- `taxonomy_cell_ab_sources` — minimum over configured cells of A/B-depth records matching that cell.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluators-corpus.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CORPUS_EVALUATORS, MeasurementUnavailable } from "../src/lib/registry/evaluators/corpus.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(sources: unknown[] | string, chapters: Record<string, string> = {}): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-corpus-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    typeof sources === "string" ? sources : sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  for (const [name, body] of Object.entries(chapters)) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  return ws;
}
const AS_OF = "2026-09-01T00:00:00.000Z";
const ctx = (workspaceDir: string) => ({ workspaceDir, asOfDate: AS_OF });

describe("corpus evaluators", () => {
  it("counts A and B depth sources as core", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A" }, { id: "s2", citation_depth: "B" }, { id: "s3", citation_depth: "C" },
    ]);
    expect(await CORPUS_EVALUATORS.core_sources(ctx(ws))).toBe(2);
  });

  it("fails the measurement when the corpus is missing, rather than reporting zero", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-empty-"));
    roots.push(ws);
    // A measured zero is a claim about the corpus. An absent corpus is not.
    await expect(CORPUS_EVALUATORS.core_sources(ctx(ws))).rejects.toThrow(MeasurementUnavailable);
  });

  it("throws on a malformed corpus row rather than silently dropping it", async () => {
    const ws = await workspace(`{"id":"s1","citation_depth":"A"}\n{ not json`);
    await expect(CORPUS_EVALUATORS.core_sources(ctx(ws))).rejects.toThrow(/malformed source record/);
  });

  it("uses the canonical cited-source parser, including whole-source markers", async () => {
    const ws = await workspace(
      [{ id: "paper-a", citation_depth: "A" }, { id: "paper-b", citation_depth: "A" }],
      { "section-01.md": "Whole [source:paper-a] and located [source:paper-b:p3].\n" });
    expect(await CORPUS_EVALUATORS.cited_sources(ctx(ws))).toBe(2);
  });

  it("measures the accepted ratio over cited sources only", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A", identity: { publication_status: "published" }, identifiers: { doi: "10.1/x" }, venue: "ICML" },
      { id: "s2", citation_depth: "A", identity: { publication_status: "preprint" }, identifiers: { arxiv_id: "2401.1" }, venue: "arXiv" },
      { id: "s3", citation_depth: "A", identity: { publication_status: "published" }, identifiers: { doi: "10.1/y" }, venue: "NeurIPS" },
    ], { "section-01.md": "[source:s1:p1] [source:s2:p2]\n" });
    expect(await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws))).toBeCloseTo(0.5, 5);
  });

  it("does not treat arxiv-only as the complement of accepted", async () => {
    // A DOI-less, arXiv-id-less workshop page is neither accepted nor arXiv-only.
    const ws = await workspace([
      { id: "s1", citation_depth: "A", identity: { publication_status: "published" }, identifiers: { doi: "10.1/x" }, venue: "ICML" },
      { id: "s2", citation_depth: "A", identity: { publication_status: "unknown" }, identifiers: {}, venue: "Workshop" },
      { id: "s3", citation_depth: "A", identity: { publication_status: "preprint" }, identifiers: { arxiv_id: "2401.1" }, venue: "arXiv" },
    ], { "section-01.md": "[source:s1:p1] [source:s2:p2] [source:s3:p3]\n" });
    const accepted = await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws));
    const arxivOnly = await CORPUS_EVALUATORS.cited_arxiv_only_ratio(ctx(ws));
    expect(accepted).toBeCloseTo(1 / 3, 5);
    expect(arxivOnly).toBeCloseTo(1 / 3, 5);
    expect(accepted + arxivOnly).toBeLessThan(1);
  });

  it("returns a zero ratio rather than NaN when nothing is cited", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A" }], { "section-01.md": "No markers.\n" });
    expect(await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws))).toBe(0);
  });

  it("is reproducible across a year boundary because the as-of date is explicit", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A", year: 2025 }],
      { "section-01.md": "[source:s1:p1]\n" });
    const inYear = await CORPUS_EVALUATORS.cited_within_one_year_ratio({ workspaceDir: ws, asOfDate: "2026-06-01T00:00:00.000Z" });
    const nextYear = await CORPUS_EVALUATORS.cited_within_one_year_ratio({ workspaceDir: ws, asOfDate: "2027-06-01T00:00:00.000Z" });
    expect(inYear).toBe(1);
    expect(nextYear).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-corpus`
Expected: FAIL — cannot resolve `evaluators/corpus.js`.

- [ ] **Step 3: Write minimal implementation**

First export the canonical helpers from `src/lib/validation/research.ts` — change `citedSourceIds`, `isAcceptedSource`, `isArxivOnlySource` and `isWithinOneCalendarYear` to `export function`, and give `isWithinOneCalendarYear` an explicit `asOf: string` parameter so it stops reading the wall clock. Update its existing call sites to pass the release run's as-of date.

Then create `packages/longwrite/src/lib/registry/evaluators/corpus.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import {
  citedSourceIds, isAcceptedSource, isArxivOnlySource, isWithinOneCalendarYear,
} from "../../validation/research.js";
import { sourceMatchesTaxonomy } from "../../research/taxonomy.js";
import { loadProjectConfig } from "../../project-config.js";
import type { ClassifiedSource } from "../../research/types.js";

export type EvaluatorContext = { workspaceDir: string; asOfDate: string };
export type EvaluatorFn = (ctx: EvaluatorContext) => Promise<number>;

/** A required input is absent. This is `measurement_failed`, never a measured
 * zero: a zero is a claim about the corpus, and an absent corpus supports no
 * claim at all. */
export class MeasurementUnavailable extends Error {
  constructor(readonly dependency: string) {
    super(`required input ${dependency} is unavailable; the measurement failed rather than measuring zero`);
    this.name = "MeasurementUnavailable";
  }
}

async function readSources(workspaceDir: string): Promise<ClassifiedSource[]> {
  const rel = "sources/classified_sources.jsonl";
  const raw = await fs.readFile(path.join(workspaceDir, rel), "utf-8").catch(() => null);
  if (raw === null) throw new MeasurementUnavailable(rel);
  return raw.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as ClassifiedSource; }
    catch { throw new Error(`malformed source record at ${rel}:${index + 1}`); }
  });
}

async function readChapters(workspaceDir: string): Promise<Array<{ rel: string; content: string }>> {
  const dir = path.join(workspaceDir, "chapters");
  const names = await fs.readdir(dir).catch(() => null);
  if (names === null) throw new MeasurementUnavailable("chapters/");
  const chapters: Array<{ rel: string; content: string }> = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    chapters.push({ rel: `chapters/${name}`, content: await fs.readFile(path.join(dir, name), "utf-8") });
  }
  return chapters;
}

/** An empty denominator is 0, never NaN: a NaN fails schema validation and
 * would surface as a broken evaluator rather than as "nothing is cited yet". */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

async function citedRecords(ctx: EvaluatorContext): Promise<ClassifiedSource[]> {
  const sources = await readSources(ctx.workspaceDir);
  const cited = citedSourceIds(await readChapters(ctx.workspaceDir));
  return sources.filter((source) => cited.has(source.id));
}

export const CORPUS_EVALUATORS: Record<string, EvaluatorFn> = {
  candidate_count: async (ctx) => (await readSources(ctx.workspaceDir)).length,

  core_sources: async (ctx) => (await readSources(ctx.workspaceDir))
    .filter((source) => source.citation_depth === "A" || source.citation_depth === "B").length,

  recent_source_ratio: async (ctx) => {
    const sources = await readSources(ctx.workspaceDir);
    return ratio(sources.filter((source) => isWithinOneCalendarYear(source, ctx.asOfDate)).length, sources.length);
  },

  source_type_diversity_count: async (ctx) => {
    const sources = await readSources(ctx.workspaceDir);
    return new Set(sources.map((source) => source.source)).size;
  },

  cited_sources: async (ctx) => (await citedRecords(ctx)).length,

  cited_within_one_year_ratio: async (ctx) => {
    const cited = await citedRecords(ctx);
    return ratio(cited.filter((source) => isWithinOneCalendarYear(source, ctx.asOfDate)).length, cited.length);
  },

  accepted_cited_ratio: async (ctx) => {
    const cited = await citedRecords(ctx);
    return ratio(cited.filter(isAcceptedSource).length, cited.length);
  },

  /** Deliberately the canonical arXiv-only rule, not `!isAcceptedSource`. A
   * workshop page with no DOI and no arXiv id is neither. */
  cited_arxiv_only_ratio: async (ctx) => {
    const cited = await citedRecords(ctx);
    return ratio(cited.filter(isArxivOnlySource).length, cited.length);
  },

  taxonomy_cell_ab_sources: async (ctx) => {
    const config = await loadProjectConfig(ctx.workspaceDir).catch(() => { throw new MeasurementUnavailable("longwrite.yaml"); });
    const cells = config.research.taxonomy;
    if (cells.length === 0) return 0;
    const sources = (await readSources(ctx.workspaceDir))
      .filter((source) => source.citation_depth === "A" || source.citation_depth === "B");
    return Math.min(...cells.map((cell) => sources.filter((source) => sourceMatchesTaxonomy(source, cell)).length));
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-corpus`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the existing research validation suite**

Run: `npm test --workspace @mr-maliang/longwrite -- research`
Expected: PASS. `isWithinOneCalendarYear` gained a parameter; update its call sites to pass the run's as-of date rather than reinstating the wall clock.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/validation/research.ts packages/longwrite/src/lib/registry/evaluators/corpus.ts packages/longwrite/tests/registry-evaluators-corpus.test.ts
git commit -m "feat(registry): add corpus evaluators reusing the canonical citation and venue helpers"
```

---

### Task 11: Evaluator registry and generated evaluator coverage

The registry declares roughly twenty script metrics. Reporting an unimplemented one as "produced by its own measurement unit" is false and hides the gap.

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluators/index.ts`
- Create: `packages/longwrite/src/lib/registry/evaluators/manuscript.ts`
- Create: `packages/longwrite/src/lib/registry/evaluators/artifacts.ts`
- Test: `packages/longwrite/tests/registry-evaluator-coverage.test.ts`

**Interfaces:**
- Consumes: `CORPUS_EVALUATORS` (Task 10); `METRIC_REGISTRY` (Task 7).
- Produces: `SCRIPT_EVALUATORS: Record<string, EvaluatorFn>` merging corpus, manuscript and artifact groups; `EVALUATOR_VERSION: string`.

`manuscript.ts` implements `prose_redundancy`, `claim_contradictions`, `outline_readiness`, `citation_depth_per_section`, `landmark_coverage_ratio`, `landmark_citation_coverage_ratio`, `citations_per_page` by delegating to the existing checks in `src/lib/ops/` and `src/lib/research/`, returning their numeric results. `artifacts.ts` implements `figures`, `tables`, `comparative_tables`, `verified_metadata_plots`, `diagram_connectivity`, `empirical_trials` from `figures/manifest.json`, `figures/placement-plan.json` and `experiments/results.json`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluator-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { SCRIPT_EVALUATORS } from "../src/lib/registry/evaluators/index.js";

describe("evaluator coverage", () => {
  it("registers exactly one evaluator for every script metric", () => {
    const missing = [...METRIC_REGISTRY.values()]
      .filter((definition) => definition.measurement_kind === "script")
      .filter((definition) => typeof SCRIPT_EVALUATORS[String(definition.metric)] !== "function")
      .map((definition) => String(definition.metric)).sort();
    expect(missing, `script metrics with no evaluator: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers no evaluator for a model or external metric", () => {
    const extra = [...METRIC_REGISTRY.values()]
      .filter((definition) => definition.measurement_kind !== "script")
      .filter((definition) => typeof SCRIPT_EVALUATORS[String(definition.metric)] === "function")
      .map((definition) => String(definition.metric)).sort();
    expect(extra, `non-script metrics with a script evaluator: ${extra.join(", ")}`).toEqual([]);
  });

  it("registers no evaluator for an unregistered metric", () => {
    const orphans = Object.keys(SCRIPT_EVALUATORS)
      .filter((name) => ![...METRIC_REGISTRY.keys()].map(String).includes(name)).sort();
    expect(orphans, `evaluators with no registered metric: ${orphans.join(", ")}`).toEqual([]);
  });

  it("declares producer, validator and reducer for every model metric", () => {
    for (const definition of METRIC_REGISTRY.values()) {
      if (definition.measurement_kind !== "model") continue;
      expect(definition.producer).toBeTruthy();
      expect(definition.validator).toBeTruthy();
      expect(definition.reducer).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluator-coverage`
Expected: FAIL — cannot resolve `evaluators/index.js`, then FAIL listing the unimplemented script metrics.

- [ ] **Step 3: Write minimal implementation**

Create the two evaluator groups, then `packages/longwrite/src/lib/registry/evaluators/index.ts`:

```ts
import { CORPUS_EVALUATORS, type EvaluatorFn } from "./corpus.js";
import { MANUSCRIPT_EVALUATORS } from "./manuscript.js";
import { ARTIFACT_EVALUATORS } from "./artifacts.js";

/** Bump when any evaluator's formula changes. Prior observations must not be
 * reused across a semantic change to how a number is produced. */
export const EVALUATOR_VERSION = "1";

export const SCRIPT_EVALUATORS: Record<string, EvaluatorFn> = {
  ...CORPUS_EVALUATORS, ...MANUSCRIPT_EVALUATORS, ...ARTIFACT_EVALUATORS,
};
export type { EvaluatorFn, EvaluatorContext } from "./corpus.js";
export { MeasurementUnavailable } from "./corpus.js";
```

Iterate until the coverage test passes. If a script metric turns out to need a build or a model, change its `measurement_kind` and tier in the registry rather than leaving it unimplemented — the test exists to force that decision to be explicit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluator-coverage`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluators/ packages/longwrite/tests/registry-evaluator-coverage.test.ts
git commit -m "feat(registry): implement every script evaluator and enforce evaluator coverage"
```

---

### Task 12: `longwrite metrics evaluate`

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluate.ts`
- Modify: `packages/longwrite/src/commands/metrics.ts`
- Modify: `packages/longwrite/src/cli.ts` (register under the existing `metrics` group)
- Test: `packages/longwrite/tests/registry-evaluate.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 8, 10, 11.
- Produces: `evaluateMetrics(workspaceDir, options): Promise<EvaluationResult>` where `options = { metrics?: MetricId[]; tier?: "unit" | "round" | "release"; asOfDate: string; modelConfig?: Record<string, unknown> }` and `EvaluationResult = { measured: Observation[]; reused: Observation[]; deferred: string[]; failed: Array<{ metric: string; reason: string }> }`; `runMetricsEvaluate(workspaceDir, options)`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluate.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metricId } from "../src/lib/registry/ids.js";
import { evaluateMetrics } from "../src/lib/registry/evaluate.js";
import { currentObservation, computeInputDigest, evaluatorDigest, STORE } from "../src/lib/registry/observations.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import { EVALUATOR_VERSION } from "../src/lib/registry/evaluators/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evaluate-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "text\n", "utf-8");
  await fs.writeFile(path.join(ws, "longwrite.yaml"), "version: 1\n", "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    [{ id: "s1", citation_depth: "A" }, { id: "s2", citation_depth: "B" }]
      .map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("metrics evaluate", () => {
  it("measures a requested metric and stores the observation", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(result.measured).toHaveLength(1);
    expect(result.measured[0].value).toBe(2);
    const definition = metricDefinition(metricId("core_sources"));
    const current = await currentObservation(ws, STORE, metricId("core_sources"),
      await computeInputDigest(ws, definition), evaluatorDigest(definition.evaluator, EVALUATOR_VERSION));
    expect(current?.value).toBe(2);
  });

  it("reuses an unchanged observation instead of re-measuring", async () => {
    const ws = await workspace();
    await evaluateMetrics(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    const second = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(second.measured).toHaveLength(0);
    expect(second.reused).toHaveLength(1);
  });

  it("re-measures once a declared dependency changes", async () => {
    const ws = await workspace();
    await evaluateMetrics(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    await fs.appendFile(path.join(ws, "sources", "classified_sources.jsonl"),
      `\n${JSON.stringify({ id: "s3", citation_depth: "A" })}`, "utf-8");
    const third = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(third.measured).toHaveLength(1);
    expect(third.measured[0].value).toBe(3);
  });

  it("defers a model metric to its own measurement unit", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, { metrics: [metricId("review_score")], asOfDate: AS_OF });
    expect(result.deferred).toContain("review_score");
    expect(result.failed).toEqual([]);
  });

  it("reports an unavailable required input as failed, never as deferred", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evaluate-bare-"));
    roots.push(ws);
    const result = await evaluateMetrics(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(result.deferred).toEqual([]);
    expect(result.failed[0].metric).toBe("core_sources");
    expect(result.failed[0].reason).toMatch(/unavailable/);
  });

  it("selects only the metrics on the requested tier", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, { tier: "release", asOfDate: AS_OF });
    expect(result.measured).toHaveLength(0);
    expect(result.deferred.sort()).toEqual(["claim_support", "rendered_visual_review", "review_score"]);
  });

  it("allocates a distinct sequence per measured observation", async () => {
    const ws = await workspace();
    const result = await evaluateMetrics(ws, {
      metrics: [metricId("core_sources"), metricId("candidate_count")], asOfDate: AS_OF,
    });
    const sequences = result.measured.map((observation) => observation.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluate`
Expected: FAIL — cannot resolve `evaluate.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/evaluate.ts`:

```ts
import { METRIC_REGISTRY, metricDefinition } from "./metrics.js";
import {
  STORE, appendObservation, computeInputDigest, currentObservation, evaluatorDigest, reserveSequence,
} from "./observations.js";
import { ObservationSchema, type Observation } from "./records.js";
import { EVALUATOR_VERSION, SCRIPT_EVALUATORS, MeasurementUnavailable } from "./evaluators/index.js";
import type { MetricId } from "./ids.js";

export type EvaluationResult = {
  measured: Observation[];
  reused: Observation[];
  /** Model or external pipelines, produced by their own measurement unit. */
  deferred: string[];
  /** A required input was unavailable, or the evaluator threw. */
  failed: Array<{ metric: string; reason: string }>;
};

export async function evaluateMetrics(
  workspaceDir: string,
  options: {
    metrics?: MetricId[];
    tier?: "unit" | "round" | "release";
    asOfDate: string;
    modelConfig?: Record<string, unknown>;
  },
): Promise<EvaluationResult> {
  const selected = options.metrics
    ?? [...METRIC_REGISTRY.values()]
      .filter((definition) => !options.tier || definition.measurement_tier === options.tier)
      .map((definition) => definition.metric);

  const result: EvaluationResult = { measured: [], reused: [], deferred: [], failed: [] };

  for (const metric of selected) {
    const definition = metricDefinition(metric);
    if (definition.measurement_kind !== "script") {
      // Genuinely produced elsewhere. Distinct from an unimplemented evaluator,
      // which must never be reported as an expected deferral.
      result.deferred.push(String(metric));
      continue;
    }
    const evaluator = SCRIPT_EVALUATORS[String(metric)];
    if (!evaluator) {
      result.failed.push({ metric: String(metric), reason: "no script evaluator is registered for this metric" });
      continue;
    }

    const extra = definition.measurement_kind === "script"
      ? { as_of_date: options.asOfDate }
      : { as_of_date: options.asOfDate, model: options.modelConfig ?? null };
    const inputDigest = await computeInputDigest(workspaceDir, definition, extra);
    const digest = evaluatorDigest(definition.evaluator, EVALUATOR_VERSION);
    const hit = await currentObservation(workspaceDir, STORE, metric, inputDigest, digest);
    if (hit) { result.reused.push(hit); continue; }

    let value: number;
    try {
      value = await evaluator({ workspaceDir, asOfDate: options.asOfDate });
    } catch (error) {
      const reason = error instanceof MeasurementUnavailable
        ? error.message
        : `evaluator threw: ${error instanceof Error ? error.message : String(error)}`;
      result.failed.push({ metric: String(metric), reason });
      continue;
    }

    const observation = ObservationSchema.parse({
      metric: String(metric), value,
      evaluator: definition.evaluator, evaluator_digest: digest, input_digest: inputDigest,
      sequence: await reserveSequence(workspaceDir, STORE),
      measured_at: new Date().toISOString(),
    });
    await appendObservation(workspaceDir, STORE, observation);
    result.measured.push(observation);
  }
  return result;
}
```

Add to `packages/longwrite/src/commands/metrics.ts`:

```ts
import { evaluateMetrics } from "../lib/registry/evaluate.js";

export async function runMetricsEvaluate(
  workspaceDir: string,
  options: { tier?: "unit" | "round" | "release"; asOf?: string },
): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const result = await evaluateMetrics(resolved, {
    tier: options.tier,
    asOfDate: options.asOf ?? new Date().toISOString(),
  });
  console.log(`Measured ${result.measured.length}, reused ${result.reused.length}, deferred ${result.deferred.length}, failed ${result.failed.length}`);
  for (const observation of result.measured) console.log(`  = ${observation.metric}: ${observation.value}`);
  for (const observation of result.reused) console.log(`  ~ ${observation.metric}: ${observation.value} (unchanged)`);
  for (const metric of result.deferred) console.log(`  . ${metric}: produced by its own measurement unit`);
  for (const failure of result.failed) console.log(`  ! ${failure.metric}: ${failure.reason}`);
  if (result.failed.length > 0) process.exitCode = 1;
}
```

Register in `src/cli.ts` under the existing `metrics` group:

```ts
metrics
  .command("evaluate <workspace>")
  .description("Measure acceptance metrics and append immutable observations")
  .option("--tier <tier>", "only measure metrics on this tier (unit, round, release)")
  .option("--as-of <iso>", "evaluation date for time-dependent metrics (defaults to now)")
  .action(async (workspace, options) => {
    const { runMetricsEvaluate } = await import("./commands/metrics.js");
    await runMetricsEvaluate(workspace, options);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluate`
Expected: PASS, 7 tests.

- [ ] **Step 5: Build and run the full suite**

Run: `npm run build --workspace @mr-maliang/longwrite && npm test --workspace @mr-maliang/longwrite`
Expected: build succeeds, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluate.ts packages/longwrite/src/commands/metrics.ts packages/longwrite/src/cli.ts packages/longwrite/tests/registry-evaluate.test.ts
git commit -m "feat(cli): add longwrite metrics evaluate with digest reuse and typed measurement failure"
```

---

### Task 13: Migrate the figures validator to structured output

All six checks in the module migrate together — a half-migrated module cannot be typed coherently.

**Files:**
- Modify: `packages/longwrite/src/lib/validation/figures.ts` (export and convert all six checks)
- Modify: `packages/longwrite/src/lib/validation/research.ts` (adapt the caller that flattens figure findings)
- Modify: `packages/longwrite/src/commands/validate.ts` (render `.diagnostic` for display)
- Modify: `packages/longwrite/tests/figures.test.ts` (assert on `.diagnostic`)
- Test: `packages/longwrite/tests/figures-structured-findings.test.ts`

**Interfaces:**
- Consumes: `FindingSchema`, `StructuredCheck` (Task 6); `resolveCapability` (Task 4).
- Produces: `checkManuscriptReferences` becomes **exported** and returns `StructuredCheck`; the other five checks in the module likewise; `validateFigureWorkspace` returns `{ pass: boolean; checks: StructuredCheck[] }`.

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
  await fs.writeFile(path.join(ws, "paper", "sections", "section-03.tex"), "Some prose.\n", "utf-8");
  await fs.writeFile(path.join(ws, "figures", "manifest.json"), JSON.stringify({
    version: 1,
    figures: [{ id: "figure-1", latex_path: "paper/figures/figure-1.tex", placement: { section_id: "section-03" } }],
    tables: [],
  }), "utf-8");
  await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({ version: 1, placements: [] }), "utf-8");
  return ws;
}

describe("figures validator structured findings", () => {
  it("is exported and emits schema-valid findings", async () => {
    const check = await checkManuscriptReferences(await workspace());
    expect(check.pass).toBe(false);
    expect(check.findings.length).toBeGreaterThan(0);
    for (const finding of check.findings) expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("names the editable producing surface, not the generated TeX", async () => {
    const check = await checkManuscriptReferences(await workspace());
    const finding = check.findings.find((f) => f.required_effect === "repair_artifact_placement");
    expect(finding?.artifact.kind).toBe("figure_spec");
    expect(finding?.artifact.path).toBe("figures/placement-plan.json");
    expect(finding?.artifact.artifact_id).toBe("figure-1");
  });

  it("carries the generated TeX location in `location`", async () => {
    const check = await checkManuscriptReferences(await workspace());
    const finding = check.findings.find((f) => f.required_effect === "repair_artifact_placement");
    expect(finding?.location).toContain("paper/sections/section-03.tex");
  });

  it("emits findings that all resolve to a capability", async () => {
    const check = await checkManuscriptReferences(await workspace());
    for (const finding of check.findings) {
      expect(() => resolveCapability({
        gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
      })).not.toThrow();
    }
  });

  it("keeps human prose available as a diagnostic", async () => {
    const check = await checkManuscriptReferences(await workspace());
    expect(check.findings[0].diagnostic).toMatch(/figure-1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- figures-structured-findings`
Expected: FAIL — `checkManuscriptReferences` is not exported (`figures.ts:229`).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/validation/figures.ts`: export all six check functions, and convert each to return `StructuredCheck`. For `checkManuscriptReferences`, replace each string push with a structured finding whose artifact is the **producing surface**:

```ts
import { FindingSchema, type Finding, type StructuredCheck } from "../registry/records.js";
import { gateId } from "../registry/ids.js";

const FIGURE_REFERENCES = gateId("figure_references");
const PLACEMENT_PLAN = "figures/placement-plan.json";

/** A defect in generated TeX names the artifact that PRODUCES the TeX, with the
 * generated location carried in `location`. Naming the .tex path with kind
 * figure_spec is rejected by FindingSchema: the kind must match the path. */
function placementFinding(
  artifactId: string, generatedPath: string,
  effect: "repair_artifact_placement" | "repair_artifact_content", diagnostic: string,
): Finding {
  return FindingSchema.parse({
    id: `${artifactId}-${effect}`,
    gate_id: FIGURE_REFERENCES,
    artifact: { kind: "figure_spec", path: PLACEMENT_PLAN, artifact_id: artifactId },
    location: `generated at ${generatedPath}`,
    required_effect: effect,
    severity: "major",
    diagnostic,
  });
}
```

Inside `embedded()`, replace each `findings.push("figure_references: …")` with the matching `placementFinding(...)` call, keeping the original message as `diagnostic`. Return:

```ts
return { id: FIGURE_REFERENCES, pass: findings.length === 0, observations: [], findings } satisfies StructuredCheck;
```

Convert the other five checks the same way, then type `validateFigureWorkspace`'s `checks` array as `StructuredCheck[]`. Finally update the two consumers: in `src/lib/validation/research.ts` and `src/commands/validate.ts`, replace any use of a check's findings as `string[]` with `check.findings.map((finding) => finding.diagnostic)` **for display only**.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- figures-structured-findings`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the figures and validation suites**

Run: `npm test --workspace @mr-maliang/longwrite -- figures validate research`
Expected: PASS. Update assertions that read finding strings to read `.diagnostic`. Never weaken an assertion to make it pass.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/validation/figures.ts packages/longwrite/src/lib/validation/research.ts packages/longwrite/src/commands/validate.ts packages/longwrite/tests/figures.test.ts packages/longwrite/tests/figures-structured-findings.test.ts
git commit -m "feat(validation): emit structured findings naming the producing surface from the figures gates"
```

---

### Task 14: Emit observations from the corpus gates

**Files:**
- Modify: `packages/longwrite/src/lib/research/corpus-gates.ts`
- Test: `packages/longwrite/tests/corpus-gates-observations.test.ts`

**Interfaces:**
- Consumes: `ObservationSchema` (Task 6); `metricDefinition` (Task 7); `computeInputDigest`, `evaluatorDigest`, `reserveSequence` (Task 8); `CORPUS_EVALUATORS` (Task 10).
- Produces: `evaluateCorpusGates(workspaceDir, options: { asOfDate: string })` gains `observations: Observation[]` on its report.

Gate ids map to registered metrics: `total_candidates` observes `candidate_count`; `core_sources` observes `core_sources`; `freshness` observes `recent_source_ratio`; `source_type_diversity` observes `source_type_diversity_count`. Each gate calls the shared evaluator once and uses its value for both the pass decision and the observation, so the two can never disagree.

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
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-corpus-obs-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1,
    project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
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

describe("corpus gate observations", () => {
  it("emits observations only for registered metrics", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.observations.length).toBeGreaterThan(0);
    for (const observation of report.observations) {
      expect(ObservationSchema.safeParse(observation).success).toBe(true);
      expect(METRIC_REGISTRY.has(metricId(observation.metric)), `${observation.metric} unregistered`).toBe(true);
    }
  });

  it("maps the core_sources gate to its metric with value and target", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.observations.find((o) => o.metric === "core_sources");
    expect(core?.value).toBe(2);
    expect(core?.target).toBe(5);
    expect(core?.operator).toBe("at_least");
  });

  it("maps the total_candidates gate to candidate_count", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.observations.find((o) => o.metric === "candidate_count")?.value).toBe(2);
  });

  it("allocates a distinct sequence per observation", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const sequences = report.observations.map((o) => o.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("agrees with the gate decision because both read one evaluator result", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.observations.find((o) => o.metric === "core_sources")!;
    const finding = report.findings.find((f) => f.id === "core_sources")!;
    expect(finding.pass).toBe(core.value >= (core.target ?? 0));
    expect(finding.detail).toContain("required 5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates-observations`
Expected: FAIL — `evaluateCorpusGates` takes no options and returns no `observations`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/research/corpus-gates.ts`, add an observation helper and thread an `asOfDate` through:

```ts
import { ObservationSchema, type Observation } from "../registry/records.js";
import { metricDefinition } from "../registry/metrics.js";
import { computeInputDigest, evaluatorDigest, reserveSequence, STORE } from "../registry/observations.js";
import { EVALUATOR_VERSION } from "../registry/evaluators/index.js";
import { metricId } from "../registry/ids.js";

async function observe(
  workspaceDir: string, asOfDate: string, metric: string,
  value: number, target: number, operator: "at_least" | "at_most",
): Promise<Observation> {
  const definition = metricDefinition(metricId(metric));
  return ObservationSchema.parse({
    metric, value, target, operator,
    evaluator: definition.evaluator,
    evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
    input_digest: await computeInputDigest(workspaceDir, definition, { as_of_date: asOfDate }),
    sequence: await reserveSequence(workspaceDir, STORE),
    measured_at: new Date().toISOString(),
  });
}
```

Compute each gate's value by calling the shared evaluator from `CORPUS_EVALUATORS` once, use that value for both the `pass` decision and the observation, and collect the observations into the returned report. Add `observations: Observation[]` to `CorpusGateReport`. Leave every existing `detail` string exactly as it is: prose stays, it just stops being the only representation. Update the callers of `evaluateCorpusGates` and `writeCorpusGateReport` to pass the run's as-of date.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates-observations`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the existing corpus-gates suite**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates`
Expected: PASS — the additions are additive apart from the new required option.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/research/corpus-gates.ts packages/longwrite/tests/corpus-gates-observations.test.ts
git commit -m "feat(research): emit registered metric observations from the corpus gates"
```

---

### Task 15: Full verification and documentation

**Files:**
- Modify: `packages/longwrite/README.md`
- Modify: `AGENTS.md` (sources-of-truth list)

- [ ] **Step 1: Run the full workspace gate**

Run:
```bash
npm run build --workspace @mr-maliang/longwrite
npm test --workspace @mr-maliang/longwrite
```
Expected: build succeeds; all tests pass, including `routing-coverage` and `registry-evaluator-coverage`.

- [ ] **Step 2: Confirm both coverage tests bite**

Already exercised for routing in Task 5 Step 3. For evaluators, temporarily add a `script` metric to `METRIC_REGISTRY` with no evaluator:

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluator-coverage`
Expected: FAIL, naming the new metric. Remove it and confirm PASS. A coverage test that cannot fail is not protecting anything.

- [ ] **Step 3: Document the new surface**

Add to `packages/longwrite/README.md`:

```markdown
### Acceptance metrics

`longwrite metrics evaluate <workspace> [--tier unit|round|release] [--as-of <iso>]`
measures metrics and appends immutable observations under
`.malaclaw/observations/`. An observation is reused only when its dependency
digest AND evaluator digest both match, so a workspace that changes and reverts
reuses the correct earlier measurement rather than the newest one.

Metrics whose pipeline is `model` or `external` are produced by their own
measurement unit and reported as deferred. A metric whose required input is
missing is reported as **failed**, never as a measured zero and never as a
deferral.
```

Add `src/lib/registry/` to the sources-of-truth list in `AGENTS.md`, noting that gate ids are declared by their producers and that routing resolves `(gate, artifact kind, required effect)` with no default.

- [ ] **Step 4: Repository release check**

Run: `npm run build && npm test && git diff --check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/README.md AGENTS.md
git commit -m "docs(longwrite): document the metric registry and metrics evaluate command"
```

---

## Plan Self-Review

**Spec coverage.**
- §A1 structured observations and findings replacing prose: Tasks 6, 13, 14.
- §A2 metric registry, measurement pipelines, tiers, invalidation, and the model-judgment uncertainty contract: Tasks 6 (judgment fields), 7, 8, 12.
- §A3 structured findings, artifact kinds, required effects, and the kind/path trust rule: Tasks 1, 6, 13.
- §A3a producer map for generated artifacts: Task 1 (`EDITABLE_KIND_PATHS`), enforced in Task 6, applied in Task 13.
- §A3b gate classes and generated coverage: Tasks 2, 3, 5.
- §A4 fail-closed routing over complete legal triples: Tasks 4, 5.

**Deliberately excluded and assigned onward.** §A9 model tiering is a compiler concern and lands in Plan 3 Task 8; the header states this rather than claiming coverage. §B4 is partial by design: dependency-driven invalidation and reuse are here, while deferred measurement, `pending_verification` and round scheduling are kernel behavior in Plan 2. §A5 to §A8 are Plan 3.

**Type consistency.** `EvaluatorFn` and `EvaluatorContext` are defined in Task 10 and re-exported by Task 11's index, which Tasks 12 and 14 import. `evaluatorDigest(name, version)` takes two arguments everywhere, with `EVALUATOR_VERSION` from Task 11. `STORE` is exported by Task 8 and used by Tasks 12 and 14. `MetricDefinition.dependencies` (not `requires`) is the field `computeInputDigest` reads. `StructuredCheck` from Task 6 is the return type adopted across all six checks in Task 13. `Criterion` in Task 9 uses `MetricId` from Task 1 and reads `tolerance` and `direction` from Task 7.

**Ordering constraints.** Task 4 must precede Task 6, because `FindingSchema` validates triples against `legalTriples`. Task 7 must precede Task 8 (`computeInputDigest` takes a `MetricDefinition`) and Task 9 (`satisfies` reads `tolerance`). Task 10 must precede Task 11, and Task 11 before Tasks 12 and 14. Task 3 deletes `review_no_regressions`, so it must precede Task 5's coverage assertions.
