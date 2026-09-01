# Contract Core, Plan 1: Registries, Producers and Measurement Envelopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every deterministic gate emit structured findings and scoped measurement entries instead of prose, behind typed producer definitions from which the routing table is generated and CI-enforced.

**Architecture:** Gates already compute both the routing triple (artifact, kind, effect) and the numeric observation, then flatten both into `string` and discard them. This plan adds `src/lib/registry/` — branded ids, **typed producer definitions colocated with each gate module**, a generated routing table, the metric registry, digests, and evaluators — then converts all nine producers. MrMaLiang produces a measurement **envelope**; MalaClaw owns storage, sequencing and arithmetic.

**Tech Stack:** TypeScript (ESM, Node 22+), Zod 3, Vitest 4, the existing `longwrite` Commander CLI.

**Specs:**
- `docs/superpowers/specs/2026-08-31-contract-enforcement-core-design.md` — §A1, §A2, §A3, §A3a, §A3b, §A4.
- `docs/superpowers/specs/2026-09-01-observation-and-criterion-wire-contract.md` — **the boundary.** §2 assigns ownership, §3 defines the envelope this plan emits, §5 defines the criteria this plan compiles.

**Explicitly out of scope:**
- **Observation storage, sequence allocation and acceptance arithmetic.** The kernel owns all three (wire contract §2). This plan emits envelope entries and stops.
- **Measurement reuse.** Whether to dispatch a measurement unit at all is a kernel scheduling decision; an evaluator measures what it is asked for.
- **§A9 model tiering** — Plan 3 Task 8, with the IR v2 units.
- **§A5–A8** — Plan 3.

## Global Constraints

- Node.js 22 or newer. ESM; **relative imports carry the `.js` extension** in `.ts` files.
- Zod schemas are `.strict()`. Malformed durable state **throws**; a skipped record becomes a trusted wrong number.
- **The routing table is generated from typed producer definitions.** Never hand-maintain a parallel list; a definition lives beside the code that emits the findings it describes.
- Routing fails closed. No default route. An unresolved triple is an error.
- **Every measurement carries `scope_key`.** A scoped metric emits one entry per scope, never an aggregate.
- **Reuse the canonical helpers.** `citedSourceIds`, `isAcceptedSource`, `isArxivOnlySource` and `isWithinOneCalendarYear` already exist in `src/lib/validation/research.ts`. A second implementation of any of them is a defect.
- A time-dependent metric declares `time_dependent: true` and takes an explicit `as_of_date` that enters its digest. A metric that does not declare it must never fold a timestamp into its digest, or every static measurement invalidates daily.
- MrMaLiang never writes `.malaclaw/`.
- Tests: `npm test --workspace @mr-maliang/longwrite`. Fixtures use `fs.mkdtemp` under `os.tmpdir()`, removed in `afterEach`, following `tests/corpus-gates.test.ts`.
- Preserve the dirty worktree. Only touch files named in a task.

## Milestones

| # | Milestone | Tasks |
| --- | --- | --- |
| M1 | Vocabulary and typed producer definitions | 1–4 |
| M2 | Structured records | 5 |
| M3 | Metric registry and digests | 6–7 |
| M4 | Scoped evaluators | 8–10 |
| M5 | Envelope emission | 11 |
| M6 | Producer migration | 12–17 |
| M7 | Verification | 18 |

---

## M1 — Vocabulary and typed producer definitions

### Task 1: Branded ids and closed vocabularies

**Files:**
- Create: `packages/longwrite/src/lib/registry/ids.ts`
- Test: `packages/longwrite/tests/registry-ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GateId`, `MetricId`, `CapabilityId` branded types with `gateId`, `metricId`, `capabilityId` constructors and schemas; `GATE_CLASSES`/`GateClass`; `ARTIFACT_KINDS`/`ArtifactKind`; `REQUIRED_EFFECTS`/`RequiredEffect`; `gateFamily`; `isParameterized`; `EDITABLE_KIND_PATHS`.

Three effects are added beyond the original set, because the routing review found gates whose only legal repair had no name: an under-length manuscript needs `expand_argument`, a publication-template defect needs `repair_template`, and a build-toolchain defect needs `repair_toolchain`.

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
  it("exposes closed, duplicate-free vocabularies", () => {
    expect(new Set(ARTIFACT_KINDS).size).toBe(ARTIFACT_KINDS.length);
    expect(new Set(REQUIRED_EFFECTS).size).toBe(REQUIRED_EFFECTS.length);
    expect([...GATE_CLASSES].sort()).toEqual(["environment", "manuscript", "measurement"]);
  });

  it("names an effect for every repair the routing review found unrepresentable", () => {
    // An under-length manuscript, a broken publication template and a missing
    // compiler each had no legal effect before.
    for (const effect of ["expand_argument", "repair_template", "repair_toolchain"]) {
      expect(REQUIRED_EFFECTS).toContain(effect);
    }
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
    expect(EDITABLE_KIND_PATHS.publication_template).toEqual([]);
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
 * the first inventory of this registry wrong twice. */
const GATE_ID = new RegExp("^" + SEGMENT + "(:" + SEGMENT + ")?$");
const PLAIN_ID = new RegExp("^" + SEGMENT + "$");

declare const gateBrand: unique symbol;
declare const metricBrand: unique symbol;
declare const capabilityBrand: unique symbol;

export type GateId = string & { readonly [gateBrand]: true };
export type MetricId = string & { readonly [metricBrand]: true };
export type CapabilityId = string & { readonly [capabilityBrand]: true };

export const GateIdSchema = z.string().regex(GATE_ID).transform((v) => v as GateId);
export const MetricIdSchema = z.string().regex(PLAIN_ID).transform((v) => v as MetricId);
export const CapabilityIdSchema = z.string().regex(PLAIN_ID).transform((v) => v as CapabilityId);

export function gateId(value: string): GateId { return GateIdSchema.parse(value); }
export function metricId(value: string): MetricId { return MetricIdSchema.parse(value); }
export function capabilityId(value: string): CapabilityId { return CapabilityIdSchema.parse(value); }

export function gateFamily(id: GateId): GateId { return id.split(":")[0] as GateId; }
export function isParameterized(id: GateId): boolean { return id.includes(":"); }

export const GATE_CLASSES = ["manuscript", "environment", "measurement"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];
export const GateClassSchema = z.enum(GATE_CLASSES);

export const ARTIFACT_KINDS = [
  "chapter_prose", "abstract", "outline",
  "figure_spec", "table_spec", "latex_layout", "publication_template", "bibliography",
  "source_record", "evidence_packet", "corpus", "experiment_manifest", "toolchain",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

export const REQUIRED_EFFECTS = [
  "add_explicit_artifact_reference", "add_supporting_citation", "remove_unsupported_claim",
  "repair_citation_marker", "replace_organizing_claim", "resolve_contradiction",
  "remove_redundant_prose", "expand_argument",
  "repair_artifact_content", "repair_artifact_placement", "repair_template",
  "acquire_additional_evidence", "upgrade_source_quality", "repair_source_metadata",
  "repair_bibliography_consistency", "repair_toolchain",
] as const;
export type RequiredEffect = (typeof REQUIRED_EFFECTS)[number];
export const RequiredEffectSchema = z.enum(REQUIRED_EFFECTS);

/** Editable path prefixes per artifact kind. A generated kind has no editable
 * path of its own: a finding against generated TeX must name the producing
 * surface and carry the generated location in `location`. */
export const EDITABLE_KIND_PATHS: Record<ArtifactKind, readonly string[]> = {
  chapter_prose: ["chapters/"],
  abstract: ["paper/abstract.md"],
  outline: ["outline.md", "outline.json"],
  figure_spec: ["figures/placement-plan.json"],
  table_spec: ["figures/placement-plan.json"],
  latex_layout: [],
  publication_template: [],
  bibliography: ["sources/bibliography.bib"],
  source_record: ["sources/classified_sources.jsonl"],
  evidence_packet: ["evidence/"],
  corpus: ["sources/"],
  experiment_manifest: [],
  toolchain: [],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-ids`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/ids.ts packages/longwrite/tests/registry-ids.test.ts
git commit -m "feat(registry): add branded ids and closed artifact/effect vocabularies"
```

---

### Task 2: Producer definition type and generated routing

The routing table is no longer authored by hand. Each producer declares, beside its checks, which gates it emits and which findings each gate can produce; the class table, legal triples and routes are all derived from those declarations.

**Files:**
- Create: `packages/longwrite/src/lib/registry/producer-types.ts`
- Create: `packages/longwrite/src/lib/registry/routing.ts`
- Test: `packages/longwrite/tests/registry-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 ids.
- Produces: `FindingShape = { kind: ArtifactKind; effect: RequiredEffect; capability: CapabilityId }`; `GateDefinition = { id: GateId; class: GateClass; findings: FindingShape[]; observes?: MetricId[] }`; `ProducerDefinition = { module: string; gates: GateDefinition[] }`; `defineProducer(definition)` validating shape; and from `routing.ts` — `registerProducers(definitions)`, `GATE_CLASS_TABLE`, `gateClass`, `gatesOfClass`, `legalTriples`, `routedTripleKeys`, `resolveCapability`, `UnroutedFindingError`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defineProducer } from "../src/lib/registry/producer-types.js";
import { gateId } from "../src/lib/registry/ids.js";
import {
  registerProducers, resolveCapability, UnroutedFindingError, legalTriples, gateClass,
} from "../src/lib/registry/routing.js";

const sample = defineProducer({
  module: "sample",
  gates: [
    { id: "visual_review", class: "manuscript", findings: [
      { kind: "chapter_prose", effect: "add_explicit_artifact_reference", capability: "revise_sections" },
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "compiler_present", class: "environment", findings: [] },
    { id: "taxonomy", class: "manuscript", findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
  ],
});
const registry = registerProducers([sample]);

describe("generated routing", () => {
  it("routes one gate to different capabilities by artifact kind", () => {
    expect(String(registry.resolveCapability({
      gate: gateId("visual_review"), kind: "chapter_prose", effect: "add_explicit_artifact_reference",
    }))).toBe("revise_sections");
    expect(String(registry.resolveCapability({
      gate: gateId("visual_review"), kind: "figure_spec", effect: "repair_artifact_content",
    }))).toBe("revise_visual_plan");
  });

  it("resolves a parameterized gate through its family", () => {
    expect(String(registry.resolveCapability({
      gate: gateId("taxonomy:agent_memory"), kind: "corpus", effect: "acquire_additional_evidence",
    }))).toBe("targeted_research_expansion");
  });

  it("throws instead of defaulting when the triple is unrouted", () => {
    expect(() => registry.resolveCapability({
      gate: gateId("visual_review"), kind: "corpus", effect: "acquire_additional_evidence",
    })).toThrow(UnroutedFindingError);
  });

  it("derives the gate class from the producer definition", () => {
    expect(registry.gateClass(gateId("visual_review"))).toBe("manuscript");
    expect(registry.gateClass(gateId("compiler_present"))).toBe("environment");
  });

  it("throws rather than defaulting for an unknown gate", () => {
    expect(() => registry.gateClass(gateId("never_declared"))).toThrow(/unclassified gate/);
  });

  it("derives legal triples from declared findings, never a parallel list", () => {
    expect(registry.legalTriples(gateId("visual_review")).map((t) => t.effect).sort())
      .toEqual(["add_explicit_artifact_reference", "repair_artifact_content"]);
  });

  it("rejects a manuscript gate that declares no findings", () => {
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "orphan", class: "manuscript", findings: [] }],
    })).toThrow(/manuscript gate.*at least one finding/i);
  });

  it("rejects an environment or measurement gate that declares findings", () => {
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "env", class: "environment", findings: [
        { kind: "corpus", effect: "acquire_additional_evidence", capability: "x" },
      ] }],
    })).toThrow(/environment.*must declare no findings/i);
  });

  it("rejects two producers declaring the same gate", () => {
    expect(() => registerProducers([sample, sample])).toThrow(/declared by more than one producer/i);
  });

  it("rejects a finding whose kind has no editable path", () => {
    // A generated kind cannot be the artifact of a repair; the producing
    // surface must be named instead.
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "g", class: "manuscript", findings: [
        { kind: "latex_layout", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
      ] }],
    })).toThrow(/no editable path/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-routing`
Expected: FAIL — cannot resolve `producer-types.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/longwrite/src/lib/registry/producer-types.ts`:

```ts
import { z } from "zod";
import {
  ArtifactKindSchema, CapabilityIdSchema, EDITABLE_KIND_PATHS, GateClassSchema,
  GateIdSchema, MetricIdSchema, RequiredEffectSchema,
} from "./ids.js";

export const FindingShape = z.object({
  kind: ArtifactKindSchema,
  effect: RequiredEffectSchema,
  capability: CapabilityIdSchema,
}).strict().superRefine((shape, ctx) => {
  if (EDITABLE_KIND_PATHS[shape.kind].length === 0) {
    ctx.addIssue({ code: "custom", path: ["kind"],
      message: `${shape.kind} has no editable path; name the producing surface instead and carry the generated location in \`location\`` });
  }
});

export const GateDefinition = z.object({
  id: GateIdSchema,
  class: GateClassSchema,
  /** Every finding this gate can legally emit. Legal triples and routes are
   * derived from this list — there is no parallel table to drift from. */
  findings: z.array(FindingShape).default([]),
  /** Metrics this gate measures while deciding. */
  observes: z.array(MetricIdSchema).default([]),
}).strict().superRefine((gate, ctx) => {
  if (gate.class === "manuscript" && gate.findings.length === 0) {
    ctx.addIssue({ code: "custom", path: ["findings"],
      message: `manuscript gate ${gate.id} must declare at least one finding it can emit` });
  }
  if (gate.class !== "manuscript" && gate.findings.length > 0) {
    ctx.addIssue({ code: "custom", path: ["findings"],
      message: `${gate.class} gate ${gate.id} must declare no findings; it is not repairable` });
  }
});

export const ProducerDefinition = z.object({
  module: z.string().min(1),
  gates: z.array(GateDefinition).min(1),
}).strict();
export type ProducerDefinition = z.infer<typeof ProducerDefinition>;
export type GateDefinition = z.infer<typeof GateDefinition>;
export type FindingShape = z.infer<typeof FindingShape>;

/** Declared beside the checks that emit these gates, so a reviewer sees the
 * declaration and the code together. */
export function defineProducer(definition: unknown): ProducerDefinition {
  return ProducerDefinition.parse(definition);
}
```

Create `packages/longwrite/src/lib/registry/routing.ts` exporting `registerProducers(definitions)` which returns `{ GATE_CLASS_TABLE, gateClass, gatesOfClass, legalTriples, routedTripleKeys, resolveCapability, producerOf }`, all derived by folding the definitions; plus a module-level `REGISTRY` built from the real producers in Task 3 and re-exported as bare functions for convenience. `resolveCapability` throws `UnroutedFindingError` carrying the key.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-routing`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/producer-types.ts packages/longwrite/src/lib/registry/routing.ts packages/longwrite/tests/registry-routing.test.ts
git commit -m "feat(registry): derive routing from typed producer definitions"
```

---

### Task 3: Declare all nine producers

This is the judgment-heavy task: every gate's real repair semantics, declared beside the code that emits it. The routing review found six gates whose previous routes were semantically wrong; each is corrected here.

**Files:**
- Modify all nine producer modules to export `PRODUCER`:
  `src/lib/validation/research.ts`, `figures.ts`, `latex.ts`, `longform.ts`,
  `src/lib/research/corpus-gates.ts`, `survey-contract.ts`,
  `src/lib/ops/visual-review.ts`, `src/lib/publication.ts`, `src/commands/preflight.ts`
- Create: `packages/longwrite/src/lib/registry/producers.ts`
- Test: `packages/longwrite/tests/registry-producers.test.ts`

**Interfaces:**
- Consumes: `defineProducer` (Task 2).
- Produces: `PRODUCER: ProducerDefinition` from each module; `PRODUCERS: ProducerDefinition[]` and the built `REGISTRY` from `producers.ts`.

**Corrections the review required.** Each is a semantic fix, not a coverage fix:

| Gate | Was | Now |
| --- | --- | --- |
| `target_length` | `remove_redundant_prose` only | adds `expand_argument` on `chapter_prose`, so an under-length manuscript is repairable |
| `research_artifacts_present` | routed to `figure_spec` | routes to `evidence_packet` + `acquire_additional_evidence` |
| `manuscript_build` | figure placement only | adds `bibliography` and `toolchain` + `repair_toolchain` |
| `publication_custom_template` | figure placement | `publication_template` + `repair_template` |
| `citation_verification` | prose marker repair only | adds `source_record` + `repair_source_metadata` and `bibliography` + `repair_bibliography_consistency` |
| `related_work_matrix` | outline only | adds `table_spec` + `repair_artifact_content` |

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-producers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRODUCERS, REGISTRY } from "../src/lib/registry/producers.js";
import { gateId } from "../src/lib/registry/ids.js";

const effectsFor = (gate: string) => REGISTRY.legalTriples(gateId(gate)).map((t) => `${t.kind}/${t.effect}`).sort();

describe("producer declarations", () => {
  it("registers all nine gate-producing modules", () => {
    expect(PRODUCERS.map((p) => p.module).sort()).toEqual([
      "corpus-gates", "figures", "latex", "longform", "preflight",
      "publication", "research", "survey-contract", "visual-review",
    ]);
  });

  it("captures the parameterized taxonomy family a text scan cannot see", () => {
    expect(REGISTRY.gateClass(gateId("taxonomy"))).toBe("manuscript");
  });

  it("makes an under-length manuscript repairable", () => {
    expect(effectsFor("target_length")).toContain("chapter_prose/expand_argument");
    expect(effectsFor("target_length")).toContain("chapter_prose/remove_redundant_prose");
  });

  it("routes missing research artifacts to evidence, not to a figure spec", () => {
    expect(effectsFor("research_artifacts_present")).toEqual(["evidence_packet/acquire_additional_evidence"]);
  });

  it("lets a build failure reach the bibliography and the toolchain", () => {
    const effects = effectsFor("manuscript_build");
    expect(effects).toContain("bibliography/repair_bibliography_consistency");
    expect(effects).toContain("toolchain/repair_toolchain");
  });

  it("routes a template defect to a template repair", () => {
    expect(effectsFor("publication_custom_template")).toEqual(["publication_template/repair_template"]);
  });

  it("lets citation verification reach source metadata and the bibliography", () => {
    const effects = effectsFor("citation_verification");
    expect(effects).toContain("source_record/repair_source_metadata");
    expect(effects).toContain("bibliography/repair_bibliography_consistency");
  });

  it("lets a related-work matrix defect reach the table spec", () => {
    expect(effectsFor("related_work_matrix")).toContain("table_spec/repair_artifact_content");
  });

  it("classifies every preflight gate as environment with no findings", () => {
    const preflight = PRODUCERS.find((p) => p.module === "preflight")!;
    for (const gate of preflight.gates) {
      expect(gate.class, String(gate.id)).toBe("environment");
      expect(gate.findings).toEqual([]);
    }
  });

  it("does not declare review_no_regressions, which must_preserve subsumes", () => {
    expect(() => REGISTRY.gateClass(gateId("review_no_regressions"))).toThrow(/unclassified/);
  });

  it("classifies empirical_experiment as environment, outside LongWrite's reach", () => {
    expect(REGISTRY.gateClass(gateId("empirical_experiment"))).toBe("environment");
  });

  it("routes every legal triple it declares", () => {
    const routed = REGISTRY.routedTripleKeys();
    const unrouted: string[] = [];
    for (const gate of REGISTRY.gatesOfClass("manuscript")) {
      for (const triple of REGISTRY.legalTriples(gate)) {
        if (!routed.has(`${gate} ${triple.kind} ${triple.effect}`)) {
          unrouted.push(`${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unrouted.sort(), `unrouted: ${unrouted.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-producers`
Expected: FAIL — cannot resolve `producers.js`.

- [ ] **Step 3: Write minimal implementation**

First **delete** the `review_no_regressions` check from `src/lib/validation/research.ts` — Spec 1 retires it, and a weaker duplicate of `must_preserve` would let a regression pass one check while failing the other.

Then, in each producer module, export a `PRODUCER` beside its checks. `figures.ts`:

```ts
import { defineProducer } from "../registry/producer-types.js";

/** Declared here so a reviewer sees the checks and their repair semantics
 * together. Legal triples and routes are generated from this. */
export const PRODUCER = defineProducer({
  module: "figures",
  gates: [
    { id: "figure_manifest", class: "manuscript", observes: ["figures", "tables"], findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "figure_artifacts", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "figure_references", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
      { kind: "chapter_prose", effect: "add_explicit_artifact_reference", capability: "revise_sections" },
    ] },
    { id: "diagram_connectivity", class: "manuscript", observes: ["diagram_connectivity"], findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "full_mode_visual_contract", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
      { kind: "table_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "publication_layout", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
    ] },
  ],
});
```

Declare the equivalent in the other eight modules, applying every correction in the table above. `corpus-gates.ts` declares the `taxonomy` family once, not per cell, and lists `observes` for each numeric gate.

Create `packages/longwrite/src/lib/registry/producers.ts`:

```ts
import { registerProducers } from "./routing.js";
import { PRODUCER as research } from "../validation/research.js";
import { PRODUCER as figures } from "../validation/figures.js";
import { PRODUCER as latex } from "../validation/latex.js";
import { PRODUCER as longform } from "../validation/longform.js";
import { PRODUCER as corpusGates } from "../research/corpus-gates.js";
import { PRODUCER as surveyContract } from "../research/survey-contract.js";
import { PRODUCER as visualReview } from "../ops/visual-review.js";
import { PRODUCER as publication } from "../publication.js";
import { PRODUCER as preflight } from "../../commands/preflight.js";

export const PRODUCERS = [
  research, figures, latex, longform, corpusGates,
  surveyContract, visualReview, publication, preflight,
];
export const REGISTRY = registerProducers(PRODUCERS);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-producers registry-routing`
Expected: PASS, 12 + 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/producers.ts packages/longwrite/src/lib/validation/ packages/longwrite/src/lib/research/corpus-gates.ts packages/longwrite/src/lib/research/survey-contract.ts packages/longwrite/src/lib/ops/visual-review.ts packages/longwrite/src/lib/publication.ts packages/longwrite/src/commands/preflight.ts packages/longwrite/tests/registry-producers.test.ts
git commit -m "feat(registry): declare all nine producers and correct six wrong routes"
```

---

### Task 4: Execution-based coverage

A declaration can still drift from the code beside it. This runs each producer against a fixture and asserts every finding it actually emits was declared.

**Files:**
- Create: `packages/longwrite/tests/routing-coverage.test.ts`
- Create: `packages/longwrite/tests/fixtures/producer-probe/` (one minimal failing workspace per producer)

**Interfaces:**
- Consumes: `REGISTRY`, `PRODUCERS` (Task 3); the producer entry points.

- [ ] **Step 1: Write the test**

Create `packages/longwrite/tests/routing-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRODUCERS, REGISTRY } from "../src/lib/registry/producers.js";
import { gateId } from "../src/lib/registry/ids.js";
import { probeProducer } from "./helpers/producer-probe.js";

describe("routing coverage", () => {
  it("routes every legal triple of every manuscript gate", () => {
    const routed = REGISTRY.routedTripleKeys();
    const unrouted: string[] = [];
    for (const gate of REGISTRY.gatesOfClass("manuscript")) {
      const triples = REGISTRY.legalTriples(gate);
      if (triples.length === 0) { unrouted.push(`${gate} (no findings declared)`); continue; }
      for (const triple of triples) {
        if (!routed.has(`${gate} ${triple.kind} ${triple.effect}`)) {
          unrouted.push(`${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unrouted.sort(), `unrouted: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("declares no findings for a non-manuscript gate", () => {
    for (const cls of ["environment", "measurement"] as const) {
      for (const gate of REGISTRY.gatesOfClass(cls)) {
        expect(REGISTRY.legalTriples(gate), String(gate)).toEqual([]);
      }
    }
  });

  it("emits only gate ids its producer declared", async () => {
    for (const producer of PRODUCERS) {
      const emitted = await probeProducer(producer.module);
      const declared = new Set(producer.gates.map((gate) => String(gate.id)));
      const undeclared = emitted.gateIds
        .map((id) => String(gateId(id)).split(":")[0])
        .filter((family) => !declared.has(family)).sort();
      expect(undeclared, `${producer.module} emits undeclared gates: ${undeclared.join(", ")}`).toEqual([]);
    }
  });

  it("emits only findings its producer declared", async () => {
    for (const producer of PRODUCERS) {
      const emitted = await probeProducer(producer.module);
      const undeclared: string[] = [];
      for (const finding of emitted.findings) {
        const legal = REGISTRY.legalTriples(finding.gate_id);
        if (!legal.some((t) => t.kind === finding.artifact.kind && t.effect === finding.required_effect)) {
          undeclared.push(`${finding.gate_id}/${finding.artifact.kind}/${finding.required_effect}`);
        }
      }
      expect(undeclared.sort(), `${producer.module}: ${undeclared.join(", ")}`).toEqual([]);
    }
  });

  it("resolves a capability for every finding a producer actually emits", async () => {
    for (const producer of PRODUCERS) {
      for (const finding of (await probeProducer(producer.module)).findings) {
        expect(() => REGISTRY.resolveCapability({
          gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
        }), `${producer.module}/${finding.id}`).not.toThrow();
      }
    }
  });
});
```

- [ ] **Step 2: Write the probe helper and fixtures**

Create `packages/longwrite/tests/helpers/producer-probe.ts` exporting `probeProducer(module: string): Promise<{ gateIds: string[]; findings: Finding[] }>`. It builds a minimal workspace under `tests/fixtures/producer-probe/<module>/` designed to **fail every check in that module**, runs the module's entry point, and returns the emitted gate ids and structured findings.

Until Task 12 onward converts a producer, its probe returns `findings: []` and only the gate-id assertions bite; each migration task extends its own probe fixture so the finding assertions become meaningful.

- [ ] **Step 3: Run it**

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: PASS, 5 tests.

- [ ] **Step 4: Prove the test bites at triple level**

Temporarily remove the `chapter_prose / add_explicit_artifact_reference` finding from `figure_references` in `figures.ts`'s `PRODUCER`, leaving the check that emits it in place. Run:

Run: `npm test --workspace @mr-maliang/longwrite -- routing-coverage`
Expected: FAIL from the "emits only findings its producer declared" case, naming `figure_references/chapter_prose/add_explicit_artifact_reference`. Restore and confirm PASS.

A gate-level check passes this mutation, because `figure_references` still emits its other findings — which is precisely why coverage compares triples **and** runs the producer.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/tests/routing-coverage.test.ts packages/longwrite/tests/helpers/producer-probe.ts packages/longwrite/tests/fixtures/producer-probe/
git commit -m "test(registry): enforce routing coverage by executing every producer"
```

---

## M2 — Structured records

### Task 5: Findings and measurement entries

**Files:**
- Create: `packages/longwrite/src/lib/registry/records.ts`
- Test: `packages/longwrite/tests/registry-records.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas and `EDITABLE_KIND_PATHS`; `REGISTRY` (Task 3).
- Produces: `FindingSchema`/`Finding`; `ModelJudgmentSchema`; `MeasurementEntrySchema`/`MeasurementEntry`; `MeasurementEnvelopeSchema`; `StructuredCheckSchema`/`StructuredCheck`.

Two rules make a finding trustworthy without an LLM in the loop: the declared `kind` must match the path it names, and the triple must be one its gate declared. `measurement_kind` — not convention — decides whether `judgment` is required.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FindingSchema, MeasurementEntrySchema, MeasurementEnvelopeSchema, StructuredCheckSchema,
} from "../src/lib/registry/records.js";

const finding = {
  id: "figure-1-missing-reference",
  gate_id: "figure_references",
  artifact: { kind: "chapter_prose", path: "chapters/section-03.md", artifact_id: "figure-1" },
  location: "paragraph preceding the float generated at paper/sections/section-03.tex",
  required_effect: "add_explicit_artifact_reference",
  severity: "major",
  diagnostic: "Figure 1 is not named before its placement.",
};

const entry = {
  metric: "core_sources", scope_key: "", status: "measured", value: 2,
  target: 5, operator: "at_least", tolerance: 0, direction: "maximize",
  evaluator: "core_sources", evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
  measurement_kind: "script",
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
    // Generated TeX is not a figure spec. The producing surface must be named,
    // with the TeX location carried in `location`.
    expect(FindingSchema.safeParse({
      ...finding, artifact: { kind: "figure_spec", path: "paper/sections/section-03.tex" },
    }).success).toBe(false);
  });

  it("rejects a triple its gate never declared", () => {
    expect(FindingSchema.safeParse({ ...finding, gate_id: "core_sources" }).success).toBe(false);
  });

  it("accepts a script measurement entry with no judgment", () => {
    expect(MeasurementEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("requires a value on a measured entry and forbids one otherwise", () => {
    expect(MeasurementEntrySchema.safeParse({ ...entry, value: undefined }).success).toBe(false);
    expect(MeasurementEntrySchema.safeParse({
      ...entry, status: "unavailable", value: undefined, reason: "corpus missing",
    }).success).toBe(true);
  });

  it("requires a reason on an unavailable entry", () => {
    expect(MeasurementEntrySchema.safeParse({
      ...entry, status: "unavailable", value: undefined,
    }).success).toBe(false);
  });

  it("requires judgment on a model entry and forbids it on a script entry", () => {
    const judgment = {
      reasons: ["comparative synthesis is thin in section 4"], confidence: 0.62,
      rubric_version: "2", evidence_refs: ["reviews/scorecard.json#persona/theorist"],
      adjudicated: false, disagreement: "none",
    };
    expect(MeasurementEntrySchema.safeParse({ ...entry, measurement_kind: "model" }).success).toBe(false);
    expect(MeasurementEntrySchema.safeParse({
      ...entry, metric: "review_score", measurement_kind: "model", judgment,
    }).success).toBe(true);
    expect(MeasurementEntrySchema.safeParse({ ...entry, judgment }).success).toBe(false);
  });

  it("rejects a confidence outside zero to one", () => {
    expect(MeasurementEntrySchema.safeParse({
      ...entry, measurement_kind: "model",
      judgment: { reasons: [], confidence: 1.4, rubric_version: "2", evidence_refs: [], adjudicated: false, disagreement: "none" },
    }).success).toBe(false);
  });

  it("accepts an envelope of scoped entries", () => {
    expect(MeasurementEnvelopeSchema.safeParse({
      version: 1, as_of_date: "2026-09-01T00:00:00.000Z",
      measurements: [
        { ...entry, metric: "citation_depth_per_section", scope_key: "section-03", value: 2 },
        { ...entry, metric: "citation_depth_per_section", scope_key: "section-06", value: 5 },
      ],
    }).success).toBe(true);
  });

  it("keeps prose only as an unparsed diagnostic on the check", () => {
    expect(StructuredCheckSchema.safeParse({
      id: "figure_references", pass: false, measurements: [entry], findings: [finding],
      diagnostic: "figure-1 is not embedded in paper/sections/section-03.tex",
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
import { REGISTRY } from "./producers.js";

function pathMatchesKind(kind: ArtifactKind, filePath: string): boolean {
  const prefixes = EDITABLE_KIND_PATHS[kind];
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) => prefix.endsWith("/") ? filePath.startsWith(prefix) : filePath === prefix);
}

export const FindingSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  gate_id: GateIdSchema,
  artifact: z.object({
    kind: ArtifactKindSchema,
    path: z.string().min(1),
    artifact_id: z.string().min(1).optional(),
  }).strict(),
  /** Where the defect shows, including a generated location such as a TeX
   * line. A generated-artifact defect uses this field, because the artifact
   * itself must name the producing surface. */
  location: z.string().min(1).max(400).optional(),
  required_effect: RequiredEffectSchema,
  severity: z.enum(["minor", "major", "critical"]),
  /** For operators. Never parsed, never routed on. */
  diagnostic: z.string().min(1).max(8_000),
}).strict().superRefine((finding, ctx) => {
  if (!pathMatchesKind(finding.artifact.kind, finding.artifact.path)) {
    ctx.addIssue({ code: "custom", path: ["artifact", "path"],
      message: `${finding.artifact.path} is not an editable ${finding.artifact.kind}; name the producing surface and put the generated location in \`location\`` });
  }
  const legal = REGISTRY.legalTriples(finding.gate_id);
  if (!legal.some((t) => t.kind === finding.artifact.kind && t.effect === finding.required_effect)) {
    ctx.addIssue({ code: "custom", path: ["required_effect"],
      message: `${finding.gate_id} never declared (${finding.artifact.kind}, ${finding.required_effect}); declare it on the producer or fix the finding` });
  }
});
export type Finding = z.infer<typeof FindingSchema>;

/** Wire contract §3: a model measurement is trusted because its acquisition,
 * validation and reduction are recorded — not because it is deterministic. */
export const ModelJudgmentSchema = z.object({
  reasons: z.array(z.string().min(1)).max(50),
  confidence: z.number().min(0).max(1),
  rubric_version: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).max(200),
  adjudicated: z.boolean(),
  disagreement: z.enum(["none", "within_tolerance", "material", "unresolved"]),
}).strict();

export const MeasurementEntrySchema = z.object({
  metric: MetricIdSchema,
  scope_key: z.string().default(""),
  status: z.enum(["measured", "unavailable", "deferred"]),
  value: z.number().finite().optional(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  tolerance: z.number().nonnegative().optional(),
  direction: z.enum(["maximize", "minimize"]).optional(),
  evaluator: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  evaluator_digest: z.string().regex(/^[0-9a-f]{64}$/),
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  measurement_kind: z.enum(["script", "model", "external"]),
  judgment: ModelJudgmentSchema.optional(),
  reason: z.string().min(1).max(2_000).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.status === "measured" && entry.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "a measured entry must carry a value" });
  }
  if (entry.status !== "measured" && entry.value !== undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "only a measured entry may carry a value" });
  }
  // An unavailable input is a failure the operator must be able to act on, so
  // it names what was missing rather than reporting a bare absence.
  if (entry.status === "unavailable" && !entry.reason) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "an unavailable entry must state why" });
  }
  if (entry.measurement_kind === "model" && entry.status === "measured" && !entry.judgment) {
    ctx.addIssue({ code: "custom", path: ["judgment"], message: "a model measurement must carry judgment" });
  }
  if (entry.measurement_kind === "script" && entry.judgment) {
    ctx.addIssue({ code: "custom", path: ["judgment"], message: "a script measurement must not carry judgment" });
  }
});
export type MeasurementEntry = z.infer<typeof MeasurementEntrySchema>;

export const MeasurementEnvelopeSchema = z.object({
  version: z.literal(1),
  as_of_date: z.string().datetime().optional(),
  measurements: z.array(MeasurementEntrySchema).max(2_000),
}).strict();
export type MeasurementEnvelope = z.infer<typeof MeasurementEnvelopeSchema>;

export const StructuredCheckSchema = z.object({
  id: GateIdSchema,
  pass: z.boolean(),
  measurements: z.array(MeasurementEntrySchema).default([]),
  findings: z.array(FindingSchema).default([]),
  diagnostic: z.string().max(8_000).optional(),
}).strict();
export type StructuredCheck = z.infer<typeof StructuredCheckSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-records`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/records.ts packages/longwrite/tests/registry-records.test.ts
git commit -m "feat(registry): add structured findings and scoped measurement entries"
```

---

## M3 — Metric registry and digests

### Task 6: Metric registry

**Files:**
- Create: `packages/longwrite/src/lib/registry/metrics.ts`
- Test: `packages/longwrite/tests/registry-metrics.test.ts`

**Interfaces:**
- Consumes: Task 1 ids.
- Produces: `MetricDefinition`; `METRIC_REGISTRY`; `PLANNER_SELECTABLE`; `metricDefinition(id)`; `metricsOfTier(tier)`.

`MetricDefinition` fields: `metric`, `scope_kind: "global" | "section" | "taxonomy_cell"`, `direction`, `target_type`, `tolerance`, `time_dependent: boolean`, `measurement_tier`, `measurement_kind`, `evaluator`, `producer?`, `validator?`, `reducer`, `dependencies: string[]`, `raw_output: string[]`, `estimated_cost`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import {
  METRIC_REGISTRY, PLANNER_SELECTABLE, metricDefinition, metricsOfTier,
} from "../src/lib/registry/metrics.js";

describe("metric registry", () => {
  it("registers every observable metric, not only planner-selectable ones", () => {
    for (const id of ["candidate_count", "recent_source_ratio", "source_type_diversity_count"]) {
      expect(METRIC_REGISTRY.has(metricId(id)), `${id} is unregistered`).toBe(true);
    }
    expect(METRIC_REGISTRY.size).toBeGreaterThan(22);
  });

  it("registers a metric for every gate a capability may protect", () => {
    // citation_verification is a GATE id; its protected form must exist as a
    // registered metric under its own name.
    expect(METRIC_REGISTRY.has(metricId("citation_verification_status"))).toBe(true);
  });

  it("allows the planner to select exactly the 22 acceptance metrics", () => {
    expect(PLANNER_SELECTABLE.size).toBe(22);
    expect(PLANNER_SELECTABLE.has(metricId("core_sources"))).toBe(true);
    expect(PLANNER_SELECTABLE.has(metricId("candidate_count"))).toBe(false);
    for (const id of PLANNER_SELECTABLE) expect(METRIC_REGISTRY.has(id)).toBe(true);
  });

  it("declares a scope kind so scoped metrics emit one entry per scope", () => {
    expect(metricDefinition(metricId("citation_depth_per_section")).scope_kind).toBe("section");
    expect(metricDefinition(metricId("taxonomy_cell_ab_sources")).scope_kind).toBe("taxonomy_cell");
    expect(metricDefinition(metricId("core_sources")).scope_kind).toBe("global");
  });

  it("marks only genuinely time-dependent metrics", () => {
    // Folding a date into every digest would invalidate every static
    // measurement daily and destroy reuse.
    expect(metricDefinition(metricId("cited_within_one_year_ratio")).time_dependent).toBe(true);
    expect(metricDefinition(metricId("recent_source_ratio")).time_dependent).toBe(true);
    expect(metricDefinition(metricId("core_sources")).time_dependent).toBe(false);
    expect(metricDefinition(metricId("prose_redundancy")).time_dependent).toBe(false);
  });

  it("marks the three expensive metrics as release tier", () => {
    expect(metricsOfTier("release").map(String).sort())
      .toEqual(["claim_support", "rendered_visual_review", "review_score"]);
  });

  it("declares producer, validator and reducer for every model pipeline", () => {
    for (const definition of METRIC_REGISTRY.values()) {
      if (definition.measurement_kind !== "model") continue;
      expect(definition.producer, `${definition.metric}`).toBeTruthy();
      expect(definition.validator, `${definition.metric}`).toBeTruthy();
      expect(definition.reducer, `${definition.metric}`).toBeTruthy();
    }
  });

  it("never lists a producer's own output as a dependency", () => {
    for (const definition of METRIC_REGISTRY.values()) {
      for (const output of definition.raw_output) {
        expect(definition.dependencies, `${definition.metric} depends on its own output`)
          .not.toContain(output);
      }
    }
  });

  it("includes chapters in the dependencies of every cited-source metric", () => {
    for (const id of ["cited_sources", "cited_within_one_year_ratio",
                      "accepted_cited_ratio", "cited_arxiv_only_ratio"]) {
      expect(metricDefinition(metricId(id)).dependencies.some((d) => d.startsWith("chapters/")),
        `${id} omits chapters`).toBe(true);
    }
  });

  it("includes validated evidence and config where a metric reads them", () => {
    expect(metricDefinition(metricId("landmark_coverage_ratio")).dependencies)
      .toContain("evidence/active-validated-source-evidence.json");
    expect(metricDefinition(metricId("taxonomy_cell_ab_sources")).dependencies)
      .toContain("longwrite.yaml");
  });

  it("records direction and tolerance so progress can be normalized", () => {
    expect(metricDefinition(metricId("prose_redundancy")).direction).toBe("minimize");
    expect(metricDefinition(metricId("core_sources")).tolerance).toBe(0);
    expect(metricDefinition(metricId("landmark_coverage_ratio")).tolerance).toBeGreaterThan(0);
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

Create `packages/longwrite/src/lib/registry/metrics.ts`. Register every observable metric — the 22 planner-selectable acceptance metrics from `src/lib/ops/action-plan.ts`, the corpus observations (`candidate_count`, `recent_source_ratio`, `source_type_diversity_count`), and a metric for every gate a capability may protect (`citation_verification_status`, `latex_build_status`). `claim_support` is canonical; the written key `claim_support_rate` is retired.

```ts
export type MetricDefinition = {
  metric: MetricId;
  /** Emits one entry per scope. A `section` or `taxonomy_cell` metric must
   * never report an aggregate: the previous taxonomy_cell_ab_sources reported
   * the minimum across cells, which cannot tell a repair which cell to fix. */
  scope_kind: "global" | "section" | "taxonomy_cell";
  direction: "maximize" | "minimize";
  target_type: "ratio" | "count" | "boolean" | "score";
  tolerance: number;
  /** Only a metric that genuinely depends on the current date. */
  time_dependent: boolean;
  measurement_tier: "unit" | "round" | "release";
  measurement_kind: "script" | "model" | "external";
  evaluator: string;
  producer?: string;
  validator?: string;
  reducer: string;
  /** Inputs whose change invalidates the measurement. Never a producer's own
   * output: that would make the measurement's identity depend on its result. */
  dependencies: string[];
  raw_output: string[];
  estimated_cost: { model_calls: number; render_required: boolean };
};
```

Populate the table following the field semantics above, with `PLANNER_SELECTABLE` holding exactly the 22 acceptance metric ids, `metricDefinition` throwing on an unknown id, and `metricsOfTier` filtering.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-metrics`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/metrics.ts packages/longwrite/tests/registry-metrics.test.ts
git commit -m "feat(registry): register every observable metric with scope, tier and dependencies"
```

---

### Task 7: Canonical hashing and digests

No store, no sequences, no reuse lookup — the kernel owns all three.

**Files:**
- Create: `packages/longwrite/src/lib/registry/canonical.ts`
- Create: `packages/longwrite/src/lib/registry/digests.ts`
- Test: `packages/longwrite/tests/registry-digests.test.ts`

**Interfaces:**
- Consumes: `MetricDefinition` (Task 6).
- Produces: `canonicalJson(value)`; `computeInputDigest(workspaceDir, definition, context)`; `evaluatorDigest(name, version)`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-digests.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../src/lib/registry/canonical.js";
import { computeInputDigest, evaluatorDigest } from "../src/lib/registry/digests.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-digests-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One\n", "utf-8");
  await fs.writeFile(path.join(ws, "longwrite.yaml"), "version: 1\n", "utf-8");
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "", "utf-8");
  return ws;
}
const AS_OF = "2026-09-01T00:00:00.000Z";
const LATER = "2027-06-01T00:00:00.000Z";

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

describe("input digests", () => {
  it("changes when a declared dependency changes", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("prose_redundancy"));
    const before = await computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One, revised\n", "utf-8");
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF })).not.toBe(before);
  });

  it("distinguishes a missing dependency from an empty one", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("prose_redundancy"));
    await fs.rm(path.join(ws, "longwrite.yaml"));
    const missing = await computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), "", "utf-8");
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF })).not.toBe(missing);
  });

  it("includes the date only for a time-dependent metric", async () => {
    const ws = await workspace();
    const dated = metricDefinition(metricId("recent_source_ratio"));
    const static_ = metricDefinition(metricId("core_sources"));
    expect(await computeInputDigest(ws, dated, { asOfDate: AS_OF }))
      .not.toBe(await computeInputDigest(ws, dated, { asOfDate: LATER }));
    // A static metric must not invalidate merely because a day passed.
    expect(await computeInputDigest(ws, static_, { asOfDate: AS_OF }))
      .toBe(await computeInputDigest(ws, static_, { asOfDate: LATER }));
  });

  it("includes nested model configuration for a model pipeline", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("review_score"));
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF, model: { name: "opus", effort: "high" } }))
      .not.toBe(await computeInputDigest(ws, definition, { asOfDate: AS_OF, model: { name: "opus", effort: "low" } }));
  });

  it("does not include the producer's raw output", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("review_score"));
    const before = await computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), "{}", "utf-8");
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF })).toBe(before);
  });

  it("changes the evaluator digest when its version changes", () => {
    expect(evaluatorDigest("core_sources", "1")).not.toBe(evaluatorDigest("core_sources", "2"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-digests`
Expected: FAIL — cannot resolve `canonical.js` and `digests.js`.

- [ ] **Step 3: Write minimal implementation**

Create `canonical.ts` with the recursive canonicaliser, and `digests.ts`:

```ts
/** Covers declared dependencies, the registry configuration, and — for a model
 * pipeline — the prompt and model configuration. It includes the evaluation
 * date ONLY when the metric declares itself time-dependent; otherwise every
 * static measurement would invalidate daily. It never covers `raw_output`. */
export async function computeInputDigest(
  workspaceDir: string, definition: MetricDefinition,
  context: { asOfDate: string; model?: Record<string, unknown> },
): Promise<string> {
  const parts: unknown[] = [
    definition.metric, definition.evaluator, definition.reducer, definition.scope_kind,
    definition.dependencies, definition.producer ?? null, definition.validator ?? null,
  ];
  for (const dependency of [...definition.dependencies].sort()) {
    parts.push(dependency, await digestOfDependency(workspaceDir, dependency));
  }
  if (definition.time_dependent) parts.push({ as_of_date: context.asOfDate });
  if (definition.measurement_kind !== "script") parts.push({ model: context.model ?? null });
  return sha256(canonicalJson(parts));
}
```

`digestOfDependency` hashes each file with an explicit present/absent marker so a missing input never hashes like an empty one.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-digests`
Expected: PASS, 2 + 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/canonical.ts packages/longwrite/src/lib/registry/digests.ts packages/longwrite/tests/registry-digests.test.ts
git commit -m "feat(registry): add canonical hashing and dependency-scoped input digests"
```

---

## M4 — Scoped evaluators

### Task 8: Evaluator protocol and corpus evaluators

**Files:**
- Modify: `packages/longwrite/src/lib/validation/research.ts` (export the four canonical helpers; give `isWithinOneCalendarYear` an explicit `asOf` parameter)
- Create: `packages/longwrite/src/lib/registry/evaluators/corpus.ts`
- Test: `packages/longwrite/tests/registry-evaluators-corpus.test.ts`

**Interfaces:**
- Consumes: the canonical helpers; `loadProjectConfig`; `sourceMatchesTaxonomy`.
- Produces: `EvaluatorContext = { workspaceDir: string; asOfDate: string }`; `ScopedValue = { scope_key: string; value: number }`; `EvaluatorFn = (ctx) => Promise<ScopedValue[]>`; `MeasurementUnavailable`; `CORPUS_EVALUATORS`.

An evaluator returns **an array of scoped values**, so a scoped metric cannot accidentally aggregate.

Formulas over `sources/classified_sources.jsonl` and `chapters/*.md`:
`candidate_count` total records · `core_sources` A/B depth · `recent_source_ratio` records passing `isWithinOneCalendarYear(record, asOfDate)` over all · `source_type_diversity_count` distinct `source` values · `cited_sources` records in `citedSourceIds(chapters)` · `cited_within_one_year_ratio`, `accepted_cited_ratio` (via `isAcceptedSource`) and `cited_arxiv_only_ratio` (via `isArxivOnlySource`) over cited records · `taxonomy_cell_ab_sources` **one entry per configured cell**.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluators-corpus.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { CORPUS_EVALUATORS, MeasurementUnavailable } from "../src/lib/registry/evaluators/corpus.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";
const ctx = (workspaceDir: string) => ({ workspaceDir, asOfDate: AS_OF });

async function workspace(
  sources: unknown[] | string, chapters: Record<string, string> = {}, taxonomy: string[] = [],
): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-corpus-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: { provider: "seed", topic: "t", taxonomy },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    typeof sources === "string" ? sources : sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  for (const [name, body] of Object.entries(chapters)) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  return ws;
}
const only = (values: Array<{ scope_key: string; value: number }>) => {
  expect(values).toHaveLength(1);
  expect(values[0].scope_key).toBe("");
  return values[0].value;
};

describe("corpus evaluators", () => {
  it("counts A and B depth sources as core, globally scoped", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A" }, { id: "s2", citation_depth: "B" }, { id: "s3", citation_depth: "C" },
    ]);
    expect(only(await CORPUS_EVALUATORS.core_sources(ctx(ws)))).toBe(2);
  });

  it("fails the measurement when the corpus is missing rather than reporting zero", async () => {
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
    expect(only(await CORPUS_EVALUATORS.cited_sources(ctx(ws)))).toBe(2);
  });

  it("does not treat arxiv-only as the complement of accepted", async () => {
    // A DOI-less, arXiv-id-less workshop page is neither.
    const ws = await workspace([
      { id: "s1", citation_depth: "A", identity: { publication_status: "published" }, identifiers: { doi: "10.1/x" }, venue: "ICML" },
      { id: "s2", citation_depth: "A", identity: { publication_status: "unknown" }, identifiers: {}, venue: "Workshop" },
      { id: "s3", citation_depth: "A", identity: { publication_status: "preprint" }, identifiers: { arxiv_id: "2401.1" }, venue: "arXiv" },
    ], { "section-01.md": "[source:s1:p1] [source:s2:p2] [source:s3:p3]\n" });
    const accepted = only(await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws)));
    const arxivOnly = only(await CORPUS_EVALUATORS.cited_arxiv_only_ratio(ctx(ws)));
    expect(accepted).toBeCloseTo(1 / 3, 5);
    expect(arxivOnly).toBeCloseTo(1 / 3, 5);
    expect(accepted + arxivOnly).toBeLessThan(1);
  });

  it("returns a zero ratio rather than NaN when nothing is cited", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A" }], { "section-01.md": "No markers.\n" });
    expect(only(await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws)))).toBe(0);
  });

  it("emits one entry per taxonomy cell, never an aggregate minimum", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A", topics: ["memory"] },
      { id: "s2", citation_depth: "A", topics: ["memory"] },
      { id: "s3", citation_depth: "B", topics: ["planning"] },
    ], {}, ["memory", "planning"]);
    const values = await CORPUS_EVALUATORS.taxonomy_cell_ab_sources(ctx(ws));
    // The previous design reported min(2, 1) = 1, which cannot tell a repair
    // which cell is short.
    expect(values.map((v) => `${v.scope_key}=${v.value}`).sort()).toEqual(["memory=2", "planning=1"]);
  });

  it("is reproducible across a year boundary because the as-of date is explicit", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A", year: 2025 }],
      { "section-01.md": "[source:s1:p1]\n" });
    expect(only(await CORPUS_EVALUATORS.cited_within_one_year_ratio({ workspaceDir: ws, asOfDate: "2026-06-01T00:00:00.000Z" }))).toBe(1);
    expect(only(await CORPUS_EVALUATORS.cited_within_one_year_ratio({ workspaceDir: ws, asOfDate: "2027-06-01T00:00:00.000Z" }))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-corpus`
Expected: FAIL — cannot resolve `evaluators/corpus.js`.

- [ ] **Step 3: Write minimal implementation**

Export `citedSourceIds`, `isAcceptedSource`, `isArxivOnlySource` and `isWithinOneCalendarYear` from `src/lib/validation/research.ts`, changing the last to take `asOf: string` and updating its existing call sites to pass the run's date rather than reading the wall clock. Then create `evaluators/corpus.ts` implementing the formulas above, with `MeasurementUnavailable` for a missing required input, a throw for a malformed row, `ratio()` returning 0 on an empty denominator, and `taxonomy_cell_ab_sources` returning one `ScopedValue` per configured cell.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-corpus`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the existing research validation suite**

Run: `npm test --workspace @mr-maliang/longwrite -- research`
Expected: PASS after updating `isWithinOneCalendarYear` call sites.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/validation/research.ts packages/longwrite/src/lib/registry/evaluators/corpus.ts packages/longwrite/tests/registry-evaluators-corpus.test.ts
git commit -m "feat(registry): add scoped corpus evaluators reusing the canonical helpers"
```

---

### Task 9: Manuscript and artifact evaluators

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluators/manuscript.ts`
- Create: `packages/longwrite/src/lib/registry/evaluators/artifacts.ts`
- Test: `packages/longwrite/tests/registry-evaluators-manuscript.test.ts`

**Interfaces:**
- Consumes: `EvaluatorFn`, `MeasurementUnavailable` (Task 8); the existing checks in `src/lib/ops/` and `src/lib/research/`.
- Produces: `MANUSCRIPT_EVALUATORS` covering `prose_redundancy`, `claim_contradictions`, `outline_readiness`, `citation_depth_per_section` (**one entry per section**), `landmark_coverage_ratio`, `landmark_citation_coverage_ratio`, `citations_per_page`, `citation_verification_status`, `latex_build_status`; `ARTIFACT_EVALUATORS` covering `figures`, `tables`, `comparative_tables`, `verified_metadata_plots`, `diagram_connectivity`, `empirical_trials`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluators-manuscript.test.ts` asserting at minimum:

```ts
it("emits one citation-depth entry per section, never an aggregate", async () => {
  const ws = await workspaceWithSections({ "section-03.md": "[source:a:p1]\n", "section-06.md": "" });
  const values = await MANUSCRIPT_EVALUATORS.citation_depth_per_section(ctx(ws));
  // Aggregating hides which section is short, and lets a repair in one
  // section appear to satisfy another.
  expect(values.map((v) => v.scope_key).sort()).toEqual(["section-03", "section-06"]);
});

it("fails the measurement when a required build artifact is absent", async () => {
  const ws = await workspaceWithoutPdf();
  await expect(MANUSCRIPT_EVALUATORS.citations_per_page(ctx(ws))).rejects.toThrow(MeasurementUnavailable);
});

it("reports a boolean gate status as zero or one", async () => {
  const ws = await workspaceWithBrokenLedger();
  expect(only(await MANUSCRIPT_EVALUATORS.citation_verification_status(ctx(ws)))).toBe(0);
});
```

plus one behavioural case per artifact evaluator.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-manuscript`
Expected: FAIL — cannot resolve `evaluators/manuscript.js`.

- [ ] **Step 3: Write minimal implementation**

Implement both modules by delegating to the existing deterministic checks and returning their numeric results as `ScopedValue[]`. A section-scoped evaluator enumerates `chapters/*.md` and emits one entry per section id. A metric requiring a build artifact that is absent throws `MeasurementUnavailable` rather than returning zero.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluators-manuscript`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluators/ packages/longwrite/tests/registry-evaluators-manuscript.test.ts
git commit -m "feat(registry): add scoped manuscript and artifact evaluators"
```

---

### Task 10: Evaluator coverage

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluators/index.ts`
- Test: `packages/longwrite/tests/registry-evaluator-coverage.test.ts`

**Interfaces:**
- Produces: `SCRIPT_EVALUATORS` merging all three groups; `EVALUATOR_VERSION`.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { SCRIPT_EVALUATORS } from "../src/lib/registry/evaluators/index.js";

describe("evaluator coverage", () => {
  it("registers exactly one evaluator for every script metric", () => {
    const missing = [...METRIC_REGISTRY.values()]
      .filter((d) => d.measurement_kind === "script")
      .filter((d) => typeof SCRIPT_EVALUATORS[String(d.metric)] !== "function")
      .map((d) => String(d.metric)).sort();
    expect(missing, `script metrics with no evaluator: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers no evaluator for a model or external metric", () => {
    const extra = [...METRIC_REGISTRY.values()]
      .filter((d) => d.measurement_kind !== "script")
      .filter((d) => typeof SCRIPT_EVALUATORS[String(d.metric)] === "function")
      .map((d) => String(d.metric)).sort();
    expect(extra, `non-script metrics with a script evaluator: ${extra.join(", ")}`).toEqual([]);
  });

  it("registers no evaluator for an unregistered metric", () => {
    const orphans = Object.keys(SCRIPT_EVALUATORS)
      .filter((name) => ![...METRIC_REGISTRY.keys()].map(String).includes(name)).sort();
    expect(orphans, `evaluators with no registered metric: ${orphans.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, then implement until it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluator-coverage`
Expected: FAIL listing unimplemented script metrics, then PASS. If a metric turns out to need a build or a model, change its `measurement_kind` and tier in the registry rather than leaving it unimplemented — this test exists to force that decision to be explicit.

- [ ] **Step 3: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluators/index.ts packages/longwrite/tests/registry-evaluator-coverage.test.ts
git commit -m "feat(registry): enforce one evaluator per script metric"
```

---

## M5 — Envelope emission

### Task 11: `longwrite metrics evaluate`

**Files:**
- Create: `packages/longwrite/src/lib/registry/evaluate.ts`
- Modify: `packages/longwrite/src/commands/metrics.ts`
- Modify: `packages/longwrite/src/cli.ts`
- Test: `packages/longwrite/tests/registry-evaluate.test.ts`

**Interfaces:**
- Consumes: Tasks 5–10.
- Produces: `buildEnvelope(workspaceDir, options): Promise<MeasurementEnvelope>` with `options = { metrics?: MetricId[]; tier?: "unit"|"round"|"release"; asOfDate: string; modelConfig?: Record<string, unknown> }`; `runMetricsEvaluate(workspaceDir, options)` writing `reports/measurements.json`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/registry-evaluate.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metricId } from "../src/lib/registry/ids.js";
import { buildEnvelope } from "../src/lib/registry/evaluate.js";
import { MeasurementEnvelopeSchema } from "../src/lib/registry/records.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";
// workspace() as in the corpus evaluator tests.

describe("metrics evaluate", () => {
  it("emits a schema-valid envelope", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(MeasurementEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.measurements[0].value).toBe(2);
  });

  it("never writes to the observation store", async () => {
    const ws = await workspace();
    await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    // The kernel owns storage and sequencing; MrMaLiang emits and stops.
    await expect(fs.access(path.join(ws, ".malaclaw"))).rejects.toThrow();
  });

  it("emits no sequence, because the kernel allocates them", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect("sequence" in envelope.measurements[0]).toBe(false);
  });

  it("emits one entry per scope for a scoped metric", async () => {
    const ws = await workspace(undefined, undefined, ["memory", "planning"]);
    const envelope = await buildEnvelope(ws, { metrics: [metricId("taxonomy_cell_ab_sources")], asOfDate: AS_OF });
    expect(envelope.measurements.map((m) => m.scope_key).sort()).toEqual(["memory", "planning"]);
  });

  it("marks a model metric deferred, not failed", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("review_score")], asOfDate: AS_OF });
    expect(envelope.measurements[0].status).toBe("deferred");
  });

  it("marks an unavailable required input failed, with a reason", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evaluate-bare-"));
    roots.push(bare);
    const envelope = await buildEnvelope(bare, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(envelope.measurements[0].status).toBe("unavailable");
    expect(envelope.measurements[0].reason).toMatch(/unavailable/);
  });

  it("reports an unimplemented script evaluator as unavailable, never deferred", async () => {
    // "Produced by its own measurement unit" is false for a missing evaluator
    // and would hide the gap.
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF, forceMissingEvaluator: true });
    expect(envelope.measurements[0].status).toBe("unavailable");
  });

  it("selects only the metrics on the requested tier", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { tier: "release", asOfDate: AS_OF });
    expect(envelope.measurements.map((m) => String(m.metric)).sort())
      .toEqual(["claim_support", "rendered_visual_review", "review_score"]);
    expect(envelope.measurements.every((m) => m.status === "deferred")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluate`
Expected: FAIL — cannot resolve `evaluate.js`.

- [ ] **Step 3: Write minimal implementation**

Create `evaluate.ts` producing one `MeasurementEntry` per `ScopedValue`, with `status: "deferred"` for a non-script `measurement_kind`, `status: "unavailable"` plus a `reason` for a `MeasurementUnavailable` or a missing evaluator, and the compiled `target`/`operator`/`tolerance`/`direction` from the metric registry and project config. Add `runMetricsEvaluate` writing `reports/measurements.json`, and register:

```ts
metrics
  .command("evaluate <workspace>")
  .description("Measure metrics and write reports/measurements.json for the engine to ingest")
  .option("--tier <tier>", "only measure metrics on this tier (unit, round, release)")
  .option("--as-of <iso>", "evaluation date for time-dependent metrics (defaults to now)")
  .action(async (workspace, options) => {
    const { runMetricsEvaluate } = await import("./commands/metrics.js");
    await runMetricsEvaluate(workspace, options);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mr-maliang/longwrite -- registry-evaluate`
Expected: PASS, 8 tests.

- [ ] **Step 5: Build and run the full suite**

Run: `npm run build --workspace @mr-maliang/longwrite && npm test --workspace @mr-maliang/longwrite`
Expected: build succeeds, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/registry/evaluate.ts packages/longwrite/src/commands/metrics.ts packages/longwrite/src/cli.ts packages/longwrite/tests/registry-evaluate.test.ts
git commit -m "feat(cli): emit a measurement envelope for the engine to ingest"
```

---

## M6 — Producer migration

Six tasks, one per producer group. Each converts that module's checks to return `StructuredCheck`, extends its probe fixture so Task 4's execution-based coverage becomes meaningful for it, and updates every caller that read findings as `string[]` to read `.diagnostic` **for display only**.

### Task 12: Figures

**Files:**
- Modify: `packages/longwrite/src/lib/validation/figures.ts` (export and convert all six checks)
- Modify: `packages/longwrite/tests/figures.test.ts`
- Modify: `packages/longwrite/tests/fixtures/producer-probe/figures/`
- Test: `packages/longwrite/tests/figures-structured.test.ts`

`checkManuscriptReferences` is currently **not exported** (`figures.ts:229`); export it. Its findings name `figures/placement-plan.json` as the producing surface with the generated TeX path in `location`.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/figures-structured.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkManuscriptReferences, validateFigureWorkspace } from "../src/lib/validation/figures.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

// workspace() builds a manifest whose figure-1 is neither labeled nor embedded.

describe("figures structured output", () => {
  it("is exported and emits schema-valid findings", async () => {
    const check = await checkManuscriptReferences(await workspace());
    expect(check.pass).toBe(false);
    for (const finding of check.findings) expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("names the editable producing surface, not the generated TeX", async () => {
    const check = await checkManuscriptReferences(await workspace());
    const finding = check.findings.find((f) => f.required_effect === "repair_artifact_placement");
    expect(finding?.artifact.kind).toBe("figure_spec");
    expect(finding?.artifact.path).toBe("figures/placement-plan.json");
    expect(finding?.artifact.artifact_id).toBe("figure-1");
    expect(finding?.location).toContain("paper/sections/section-03.tex");
  });

  it("emits findings that all resolve to a capability", async () => {
    for (const finding of (await checkManuscriptReferences(await workspace())).findings) {
      expect(() => REGISTRY.resolveCapability({
        gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
      })).not.toThrow();
    }
  });

  it("converts every check in the module, not only one", async () => {
    const report = await validateFigureWorkspace(await workspace());
    for (const check of report.checks) {
      expect(Array.isArray(check.findings)).toBe(true);
      for (const finding of check.findings) expect(typeof finding).toBe("object");
    }
  });

  it("keeps human prose available as a diagnostic", async () => {
    const check = await checkManuscriptReferences(await workspace());
    expect(check.findings[0].diagnostic).toMatch(/figure-1/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- figures-structured`
Expected: FAIL — `checkManuscriptReferences` is not exported.

- [ ] **Step 3: Convert the module**

Export all six checks and return `StructuredCheck` from each, replacing every string push with a `FindingSchema.parse(...)` whose `diagnostic` is the original message. Type `validateFigureWorkspace`'s `checks` as `StructuredCheck[]`. Extend the probe fixture so each of the module's six gates fails.

- [ ] **Step 4: Run the figures and coverage suites**

Run: `npm test --workspace @mr-maliang/longwrite -- figures routing-coverage`
Expected: PASS. Update `tests/figures.test.ts` assertions that read finding strings to read `.diagnostic`; never weaken an assertion to make it pass.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/lib/validation/figures.ts packages/longwrite/tests/figures.test.ts packages/longwrite/tests/figures-structured.test.ts packages/longwrite/tests/fixtures/producer-probe/figures/
git commit -m "feat(validation): convert the figures producer to structured findings"
```

---

### Task 13: Corpus gates

**Files:**
- Modify: `packages/longwrite/src/lib/research/corpus-gates.ts`
- Modify: `packages/longwrite/tests/corpus-gates.test.ts`
- Modify: `packages/longwrite/tests/fixtures/producer-probe/corpus-gates/`
- Test: `packages/longwrite/tests/corpus-gates-structured.test.ts`

Gate-to-metric mapping: `total_candidates → candidate_count`, `core_sources → core_sources`, `freshness → recent_source_ratio`, `source_type_diversity → source_type_diversity_count`, `taxonomy:<cell> → taxonomy_cell_ab_sources` scoped to that cell.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/corpus-gates-structured.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { evaluateCorpusGates } from "../src/lib/research/corpus-gates.js";
import { MeasurementEntrySchema } from "../src/lib/registry/records.js";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-corpus-structured-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi", topic: "agent memory", taxonomy: ["memory", "planning"],
      corpus_gates: {
        min_candidates: 1, min_sources_per_taxonomy_cell: 2, min_core_sources: 5,
        min_recent_ratio: 0, min_source_type_diversity: 1,
      },
    },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    [{ id: "s1", citation_depth: "A", source: "arxiv", topics: ["memory"] },
     { id: "s2", citation_depth: "B", source: "arxiv", topics: ["memory"] },
     { id: "s3", citation_depth: "B", source: "arxiv", topics: ["planning"] }]
      .map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("corpus gate structured output", () => {
  it("emits entries only for registered metrics", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.measurements.length).toBeGreaterThan(0);
    for (const entry of report.measurements) {
      expect(MeasurementEntrySchema.safeParse(entry).success).toBe(true);
      expect(METRIC_REGISTRY.has(metricId(entry.metric)), `${entry.metric} unregistered`).toBe(true);
    }
  });

  it("maps the core_sources gate to its metric with value, target and operator", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.measurements.find((entry) => entry.metric === "core_sources");
    expect(core?.value).toBe(3);
    expect(core?.target).toBe(5);
    expect(core?.operator).toBe("at_least");
  });

  it("maps the total_candidates gate to candidate_count", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.measurements.find((entry) => entry.metric === "candidate_count")?.value).toBe(3);
  });

  it("emits one taxonomy entry per cell, never an aggregate", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const cells = report.measurements.filter((entry) => entry.metric === "taxonomy_cell_ab_sources");
    expect(cells.map((entry) => `${entry.scope_key}=${entry.value}`).sort())
      .toEqual(["memory=2", "planning=1"]);
  });

  it("emits no sequence, because the kernel allocates them", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    for (const entry of report.measurements) expect("sequence" in entry).toBe(false);
  });

  it("agrees with the gate decision because both read one evaluator result", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.measurements.find((entry) => entry.metric === "core_sources")!;
    const finding = report.findings.find((entry) => entry.id === "core_sources")!;
    expect(finding.pass).toBe(core.value! >= core.target!);
  });

  it("keeps the existing prose detail for operators", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.findings.find((entry) => entry.id === "core_sources")?.detail).toContain("required 5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates-structured`
Expected: FAIL — `evaluateCorpusGates` takes no options and returns no `measurements`.

- [ ] **Step 3: Convert the module**

Give `evaluateCorpusGates` a second parameter `{ asOfDate: string }`. For each numeric gate, call the matching evaluator from `CORPUS_EVALUATORS` **once** and use its `ScopedValue[]` for both the `pass` decision and the emitted entries, so the two can never disagree. Build each entry with `MeasurementEntrySchema.parse`, taking `target` and `operator` from `config.research.corpus_gates` and `tolerance`/`direction` from `metricDefinition`. Add `measurements: MeasurementEntry[]` to `CorpusGateReport`. Leave every existing `detail` string exactly as it is.

- [ ] **Step 4: Update callers and the probe fixture**

Pass the run's as-of date from every `evaluateCorpusGates` and `writeCorpusGateReport` call site. Extend `tests/fixtures/producer-probe/corpus-gates/` so all five gates fail.

- [ ] **Step 5: Run the corpus and coverage suites**

Run: `npm test --workspace @mr-maliang/longwrite -- corpus-gates routing-coverage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/research/corpus-gates.ts packages/longwrite/tests/corpus-gates.test.ts packages/longwrite/tests/corpus-gates-structured.test.ts packages/longwrite/tests/fixtures/producer-probe/corpus-gates/
git commit -m "feat(research): emit registered scoped measurements from the corpus gates"
```

---

### Task 14: Research validator

**Files:**
- Modify: `packages/longwrite/src/lib/validation/research.ts`
- Modify: `packages/longwrite/src/commands/validate.ts`
- Modify: `packages/longwrite/tests/fixtures/producer-probe/research/`
- Test: `packages/longwrite/tests/research-structured.test.ts`

The largest producer, and the one whose routes changed most.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/research-structured.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
// workspace(overrides) builds a research workspace whose specific defect is
// chosen per test: a dead citation URL, an under-length manuscript, and so on.

const findingsFor = async (ws: string, gate: string) =>
  (await validateResearchWorkspace(ws)).checks.find((check) => check.id === gate)?.findings ?? [];

describe("research validator structured output", () => {
  it("emits schema-valid findings from every check", async () => {
    const report = await validateResearchWorkspace(await workspace({ brokenEverything: true }));
    for (const check of report.checks) {
      for (const finding of check.findings) expect(FindingSchema.safeParse(finding).success).toBe(true);
    }
  });

  it("routes a dead citation URL to source-record metadata, not prose", async () => {
    const findings = await findingsFor(await workspace({ deadUrl: true }), "citation_verification");
    const metadata = findings.find((f) => f.artifact.kind === "source_record");
    expect(metadata?.required_effect).toBe("repair_source_metadata");
  });

  it("routes an unresolved bibliography entry to bibliography repair", async () => {
    const findings = await findingsFor(await workspace({ danglingBibEntry: true }), "citation_verification");
    expect(findings.some((f) => f.artifact.kind === "bibliography"
      && f.required_effect === "repair_bibliography_consistency")).toBe(true);
  });

  it("asks to expand an under-length manuscript rather than trim it", async () => {
    // The previous table offered only remove_redundant_prose, leaving an
    // under-length manuscript unrepairable.
    const findings = await findingsFor(await workspace({ words: 500, targetWords: 5_000 }), "target_length");
    expect(findings[0].required_effect).toBe("expand_argument");
  });

  it("asks to trim an over-length manuscript", async () => {
    const findings = await findingsFor(await workspace({ words: 9_000, targetWords: 5_000 }), "target_length");
    expect(findings[0].required_effect).toBe("remove_redundant_prose");
  });

  it("routes missing research artifacts to evidence acquisition, not a figure spec", async () => {
    const findings = await findingsFor(await workspace({ noArtifacts: true }), "research_artifacts_present");
    expect(findings[0].artifact.kind).toBe("evidence_packet");
    expect(findings[0].required_effect).toBe("acquire_additional_evidence");
  });

  it("emits findings that all resolve to a capability", async () => {
    const report = await validateResearchWorkspace(await workspace({ brokenEverything: true }));
    for (const check of report.checks) {
      for (const finding of check.findings) {
        expect(() => REGISTRY.resolveCapability({
          gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
        }), finding.id).not.toThrow();
      }
    }
  });

  it("no longer emits review_no_regressions", async () => {
    const report = await validateResearchWorkspace(await workspace({ brokenEverything: true }));
    expect(report.checks.map((check) => String(check.id))).not.toContain("review_no_regressions");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- research-structured`
Expected: FAIL — checks return `findings: string[]`.

- [ ] **Step 3: Convert the module**

Return `StructuredCheck` from every check. `citation_verification` selects its finding shape from the failure it actually found: an unresolvable marker gives `chapter_prose / repair_citation_marker`, a dead or missing URL gives `source_record / repair_source_metadata`, a dangling bib entry gives `bibliography / repair_bibliography_consistency`. `target_length` compares the word count to the target and emits `expand_argument` or `remove_redundant_prose` accordingly. `research_artifacts_present` emits `evidence_packet / acquire_additional_evidence`.

- [ ] **Step 4: Update the display caller and probe fixture**

In `src/commands/validate.ts`, render `check.findings.map((finding) => finding.diagnostic)` for display only. Extend `tests/fixtures/producer-probe/research/` so every gate in the module fails.

- [ ] **Step 5: Run the research and coverage suites**

Run: `npm test --workspace @mr-maliang/longwrite -- research validate routing-coverage`
Expected: PASS. Update assertions that read finding strings to read `.diagnostic`.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/validation/research.ts packages/longwrite/src/commands/validate.ts packages/longwrite/tests/research-structured.test.ts packages/longwrite/tests/fixtures/producer-probe/research/
git commit -m "feat(validation): convert the research producer and correct three wrong routes"
```

---

### Task 15: LaTeX and long-form

**Files:**
- Modify: `packages/longwrite/src/lib/validation/latex.ts`
- Modify: `packages/longwrite/src/lib/validation/longform.ts`
- Modify: `packages/longwrite/tests/fixtures/producer-probe/latex/`, `.../longform/`
- Test: `packages/longwrite/tests/latex-longform-structured.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/latex-longform-structured.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateLatexWorkspace } from "../src/lib/validation/latex.js";
import { validateLongformWorkspace } from "../src/lib/validation/longform.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
// latexWorkspace(kind) seeds a build log containing either an undefined
// citation warning, a missing-package fatal, or a float placement error.

describe("latex and longform structured output", () => {
  it("routes a missing package to a toolchain repair", async () => {
    const report = await validateLatexWorkspace(await latexWorkspace("missing_package"));
    const build = report.checks.find((check) => check.id === "latex_build")!;
    expect(build.findings.some((f) => f.artifact.kind === "toolchain"
      && f.required_effect === "repair_toolchain")).toBe(true);
  });

  it("routes an undefined citation to bibliography repair", async () => {
    const report = await validateLatexWorkspace(await latexWorkspace("undefined_citation"));
    const build = report.checks.find((check) => check.id === "latex_build")!;
    expect(build.findings.some((f) => f.artifact.kind === "bibliography"
      && f.required_effect === "repair_bibliography_consistency")).toBe(true);
  });

  it("routes a float placement failure to the placement plan", async () => {
    const report = await validateLatexWorkspace(await latexWorkspace("float_placement"));
    const build = report.checks.find((check) => check.id === "latex_build")!;
    const placement = build.findings.find((f) => f.artifact.kind === "figure_spec");
    expect(placement?.artifact.path).toBe("figures/placement-plan.json");
    expect(placement?.required_effect).toBe("repair_artifact_placement");
  });

  it("asks to expand an under-length long-form manuscript", async () => {
    const report = await validateLongformWorkspace(await longformWorkspace({ words: 500, target: 5_000 }));
    const length = report.checks.find((check) => check.id === "target_length")!;
    expect(length.findings[0].required_effect).toBe("expand_argument");
  });

  it("routes style drift to prose revision", async () => {
    const report = await validateLongformWorkspace(await longformWorkspace({ drift: true }));
    const drift = report.checks.find((check) => check.id === "style_drift")!;
    expect(drift.findings[0].artifact.kind).toBe("chapter_prose");
  });

  it("emits schema-valid findings that all resolve to a capability", async () => {
    for (const report of [
      await validateLatexWorkspace(await latexWorkspace("missing_package")),
      await validateLongformWorkspace(await longformWorkspace({ drift: true })),
    ]) {
      for (const check of report.checks) {
        for (const finding of check.findings) {
          expect(FindingSchema.safeParse(finding).success).toBe(true);
          expect(() => REGISTRY.resolveCapability({
            gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
          })).not.toThrow();
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- latex-longform-structured`
Expected: FAIL — both modules return `findings: string[]`.

- [ ] **Step 3: Convert both modules**

Return `StructuredCheck` from every check. `latex_build` and `manuscript_build` classify the build log: a missing package or compiler fault gives `toolchain / repair_toolchain`, an undefined citation gives `bibliography / repair_bibliography_consistency`, and anything else gives `figure_spec / repair_artifact_placement` naming `figures/placement-plan.json` with the TeX location in `location`. `target_length` chooses by direction; `style_drift` emits a prose finding.

- [ ] **Step 4: Extend the probe fixtures**

Seed `tests/fixtures/producer-probe/latex/` and `.../longform/` so every gate in each module fails.

- [ ] **Step 5: Run the suites**

Run: `npm test --workspace @mr-maliang/longwrite -- latex longform routing-coverage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/validation/latex.ts packages/longwrite/src/lib/validation/longform.ts packages/longwrite/tests/latex-longform-structured.test.ts packages/longwrite/tests/fixtures/producer-probe/
git commit -m "feat(validation): convert the latex and longform producers to structured findings"
```

---

### Task 16: Publication, survey contract and visual review

**Files:**
- Modify: `packages/longwrite/src/lib/publication.ts`
- Modify: `packages/longwrite/src/lib/research/survey-contract.ts`
- Modify: `packages/longwrite/src/lib/ops/visual-review.ts`
- Modify: `packages/longwrite/tests/fixtures/producer-probe/publication/`, `.../survey-contract/`, `.../visual-review/`
- Test: `packages/longwrite/tests/publication-survey-visual-structured.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/publication-survey-visual-structured.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePublication } from "../src/lib/publication.js";
import { evaluateSurveyContract } from "../src/lib/research/survey-contract.js";
import { checkVisualReviewReleaseGate } from "../src/lib/ops/visual-review.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
// visualWorkspace(defect) seeds reviews/visual-qa.json with a failing page
// whose remediation is either a missing prose reference, unreadable figure
// content, or a float that ran off the page.

describe("publication, survey and visual-review structured output", () => {
  it("routes a broken publication template to a template repair", async () => {
    const report = await validatePublication(await publicationWorkspace({ badTemplate: true }));
    const check = report.checks.find((entry) => entry.id === "publication_custom_template")!;
    expect(check.findings[0].artifact.kind).toBe("publication_template");
    expect(check.findings[0].required_effect).toBe("repair_template");
  });

  it("routes an over-length submission to prose trimming", async () => {
    const report = await validatePublication(await publicationWorkspace({ pages: 20, limit: 9 }));
    const check = report.checks.find((entry) => entry.id === "publication_page_limit")!;
    expect(check.findings[0].required_effect).toBe("remove_redundant_prose");
  });

  it("lets a related-work matrix defect reach the table spec", async () => {
    const { report } = await evaluateSurveyContract(await surveyWorkspace({ thinMatrix: true }));
    const check = report.checks.find((entry) => entry.id === "related_work_matrix")!;
    expect(check.findings.some((f) => f.artifact.kind === "table_spec")).toBe(true);
  });

  it("routes a missing prose reference on the visual gate to the section editor", async () => {
    // The case that motivated this whole design: a rendered-visual defect whose
    // repair is prose, not a figure.
    const check = await checkVisualReviewReleaseGate(await visualWorkspace("missing_prose_reference"), true);
    const finding = check.findings.find((f) => f.artifact.kind === "chapter_prose")!;
    expect(finding.required_effect).toBe("add_explicit_artifact_reference");
    expect(String(REGISTRY.resolveCapability({
      gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
    }))).toBe("revise_sections");
  });

  it("routes unreadable figure content on the same gate to the visual planner", async () => {
    const check = await checkVisualReviewReleaseGate(await visualWorkspace("unreadable_figure"), true);
    const finding = check.findings.find((f) => f.artifact.kind === "figure_spec")!;
    expect(String(REGISTRY.resolveCapability({
      gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
    }))).toBe("revise_visual_plan");
  });

  it("emits schema-valid findings across all three modules", async () => {
    const checks = [
      ...(await validatePublication(await publicationWorkspace({ badTemplate: true }))).checks,
      ...(await evaluateSurveyContract(await surveyWorkspace({ thinMatrix: true }))).report.checks,
      await checkVisualReviewReleaseGate(await visualWorkspace("unreadable_figure"), true),
    ];
    for (const check of checks) {
      for (const finding of check.findings) expect(FindingSchema.safeParse(finding).success).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- publication-survey-visual-structured`
Expected: FAIL — all three modules return `findings: string[]`.

- [ ] **Step 3: Convert the three modules**

Return `StructuredCheck` from every check. `publication_custom_template` emits `publication_template / repair_template`; `publication_page_limit` and `publication_min_pages` choose trimming or expansion by direction; `related_work_matrix` emits a `table_spec` finding alongside its outline finding. `checkVisualReviewReleaseGate` maps each failing page's recorded remediation to one of the four shapes its producer declares.

- [ ] **Step 4: Extend the probe fixtures** for all three modules so every gate fails.

- [ ] **Step 5: Run the suites**

Run: `npm test --workspace @mr-maliang/longwrite -- publication survey visual routing-coverage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/lib/publication.ts packages/longwrite/src/lib/research/survey-contract.ts packages/longwrite/src/lib/ops/visual-review.ts packages/longwrite/tests/publication-survey-visual-structured.test.ts packages/longwrite/tests/fixtures/producer-probe/
git commit -m "feat(validation): convert the publication, survey and visual-review producers"
```

---

### Task 17: Preflight

**Files:**
- Modify: `packages/longwrite/src/commands/preflight.ts`
- Modify: `packages/longwrite/tests/fixtures/producer-probe/preflight/`
- Test: `packages/longwrite/tests/preflight-structured.test.ts`

Every preflight gate is `environment`. It may emit measurements, but **no findings**: a missing LaTeX compiler is not repaired by editing prose, and routing it to a capability is the category error this class exists to prevent.

- [ ] **Step 1: Write the failing test**

Create `packages/longwrite/tests/preflight-structured.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPreflightChecks } from "../src/commands/preflight.js";
import { PRODUCERS, REGISTRY } from "../src/lib/registry/producers.js";
import { gateId } from "../src/lib/registry/ids.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
// bareWorkspace() has no LaTeX compiler, no figure renderer and no worker
// runtime configured, so every preflight check fails.

describe("preflight structured output", () => {
  it("emits no findings, because an environment gate is not repairable", async () => {
    const report = await runPreflightChecks(await bareWorkspace());
    for (const check of report.checks) {
      expect(check.findings, `${check.id} emitted a finding`).toEqual([]);
    }
  });

  it("still reports failure with an operator diagnostic", async () => {
    const report = await runPreflightChecks(await bareWorkspace());
    const compiler = report.checks.find((check) => check.id === "pdf_compiler")!;
    expect(compiler.pass).toBe(false);
    expect(compiler.diagnostic).toMatch(/compiler/i);
  });

  it("declares every one of its gates as environment class", () => {
    const preflight = PRODUCERS.find((producer) => producer.module === "preflight")!;
    for (const gate of preflight.gates) expect(REGISTRY.gateClass(gate.id)).toBe("environment");
  });

  it("has no legal triples, so nothing can route to a repair", () => {
    const preflight = PRODUCERS.find((producer) => producer.module === "preflight")!;
    for (const gate of preflight.gates) {
      expect(REGISTRY.legalTriples(gate.id), String(gate.id)).toEqual([]);
    }
  });

  it("routes a missing compiler nowhere at all", () => {
    expect(REGISTRY.legalTriples(gateId("pdf_compiler"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mr-maliang/longwrite -- preflight-structured`
Expected: FAIL — preflight checks return `findings: string[]`, which the first case reads as non-empty.

- [ ] **Step 3: Convert the module**

Return `StructuredCheck` from every preflight check with `findings: []` and the original message moved to `diagnostic`. Emit measurements where a check already computes a number (for example a token budget), naming registered metrics only.

- [ ] **Step 4: Extend the probe fixture** so every preflight gate fails.

- [ ] **Step 5: Run the suites**

Run: `npm test --workspace @mr-maliang/longwrite -- preflight routing-coverage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/longwrite/src/commands/preflight.ts packages/longwrite/tests/preflight-structured.test.ts packages/longwrite/tests/fixtures/producer-probe/preflight/
git commit -m "feat(preflight): emit environment-class checks with no findings"
```

---

## M7 — Verification

### Task 18: Full verification and documentation

**Files:**
- Modify: `packages/longwrite/README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Run the full gate**

Run:
```bash
npm run build --workspace @mr-maliang/longwrite
npm test --workspace @mr-maliang/longwrite
```
Expected: PASS, including `routing-coverage` with every producer's finding assertions now meaningful.

- [ ] **Step 2: Confirm both coverage tests bite**

Routing coverage was exercised in Task 4 Step 4. For evaluator coverage, temporarily add a `script` metric with no evaluator and confirm `registry-evaluator-coverage` fails naming it, then remove it.

- [ ] **Step 3: Document**

In `packages/longwrite/README.md`:

```markdown
### Measurement

`longwrite metrics evaluate <workspace> [--tier unit|round|release] [--as-of <iso>]`
writes `reports/measurements.json`, a measurement envelope the MalaClaw engine
ingests. MrMaLiang measures; the engine stores, sequences and evaluates.

A scoped metric emits one entry per scope. A metric whose pipeline is `model`
or `external` is reported **deferred**; one whose required input is missing is
reported **unavailable** with a reason — never a measured zero, and never a
deferral.
```

In `AGENTS.md`, add `src/lib/registry/` to the sources-of-truth list, noting that gate ids and their legal findings are declared by typed producer definitions beside the checks, that routing resolves `(gate, artifact kind, required effect)` with no default, and that MrMaLiang never writes `.malaclaw/`.

- [ ] **Step 4: Repository release check**

Run: `npm run build && npm test && git diff --check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/README.md AGENTS.md
git commit -m "docs(longwrite): document producer definitions and measurement envelopes"
```

---

## Plan Self-Review

**Spec coverage.** §A1 structured observations and findings → Tasks 5, 12–17. §A2 metric registry, pipelines, tiers, dependency-driven invalidation and the model-judgment contract → Tasks 5, 6, 7. §A3 findings, artifact kinds, effects and the kind/path trust rule → Tasks 1, 5. §A3a producer map for generated artifacts → Task 1's `EDITABLE_KIND_PATHS`, enforced in Task 5, applied in Tasks 12–17. §A3b gate classes and generated coverage → Tasks 2, 3, 4. §A4 fail-closed routing over declared triples → Tasks 2, 3.

**Wire contract coverage.** §2 ownership — this plan emits envelopes and writes nothing under `.malaclaw/` (asserted in Task 11). §3 envelope, including `measured`/`unavailable`/`deferred` and the judgment rule → Tasks 5, 11. §4 identity — `scope_key` is carried on every entry; storage is the kernel's. §5 compiled criteria — `target`, `operator`, `tolerance` and `direction` come from the metric registry and project config in Task 11.

**Deliberately excluded.** Observation storage, sequence allocation, acceptance arithmetic and reuse scheduling are the kernel's (Plan 2). §A9 model tiering and §A5–A8 are Plan 3.

**Type consistency.** `ProducerDefinition` (Task 2) is what each module exports in Task 3 and what `producers.ts` folds into `REGISTRY`. `REGISTRY.legalTriples` is consumed by `FindingSchema` (Task 5) and by the coverage test (Task 4). `EvaluatorContext`, `ScopedValue`, `EvaluatorFn` and `MeasurementUnavailable` are defined in Task 8 and re-exported by Task 10's index for Tasks 9 and 11. `evaluatorDigest(name, version)` takes two arguments everywhere, with `EVALUATOR_VERSION` from Task 10. `MetricDefinition.dependencies` — never `requires` — is what `computeInputDigest` reads.

**Ordering constraints.** Task 3 must precede Task 5, because `FindingSchema` validates triples against `REGISTRY`. Task 6 precedes Task 7 (`computeInputDigest` takes a `MetricDefinition`). Task 8 precedes Tasks 9, 10, 11. Task 4's probe helper is created before Tasks 12–17, each of which extends its own fixture. Task 3 deletes `review_no_regressions`, so it precedes Task 4's assertions.
