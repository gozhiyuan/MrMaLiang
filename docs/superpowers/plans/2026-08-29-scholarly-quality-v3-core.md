# Scholarly Quality v3 Core Capabilities Implementation Plan

> Status (2026-08-30): implemented. The unchecked boxes below are retained as
> the historical execution recipe; the shipped implementation additionally
> includes profile defaults, directional acceptance criteria, strict repair
> ownership, A/B evidence and manuscript-citation landmark gates, and
> fail-closed schema validation discovered during final review.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four deterministic quality gates (landmark-literature coverage, cross-section claim contradiction, prose redundancy, diagram-caption connectivity) and a system-card evidence schema to the `packages/longwrite` research-paper pipeline, so the `improve` phase's existing repair loop can actually detect and route the defect classes found in the `short-rsi-survey` flagship run: missing canonical literature (DGM/STOP/Promptbreeder/ADAS/AFlow/AgentSquare), a live contradiction between Sections 5/8 and Section 9, 57 occurrences of the word "packet" leaking into reader-facing prose, and a killer figure whose caption claims one connected loop but whose rendered graph is two disconnected components.

**Architecture:** Every new capability is a pure, deterministically-testable function following this codebase's existing gate pattern (`ValidationCheck = {id, pass, findings}`, composed into `validateResearchWorkspace`/`validateFigureWorkspace`'s `checks` array — see `src/lib/validation/research.ts` and `src/lib/validation/figures.ts`). No new MalaClaw `tool_catalog` actions or `action_dispatch` stages are added: all four new finding types route through the **existing** `revise_sections`, `revise_visual_plan`, `targeted_research_expansion`, and `reopen_outline` capabilities by extending the `action_plan` planner's acceptance-criteria vocabulary at `composition.ts:933`. Contradiction detection extends the existing `claim_judge` stage (which already double-reviews sampled claims per section) with `subject_key`/`polarity` fields rather than adding a parallel extraction stage. One new pipeline stage (`landmark_scout`) is added because nothing in the current pipeline searches for canonical works before broad recall.

**Tech Stack:** TypeScript, Zod (schema validation), Vitest (no mocking library — pure functions over temp-directory fixtures), YAML (base workflow definitions), MalaClaw SDK builders (`agentStage`, `scriptStage`) for stage composition.

**Spec:** No separate spec document — this plan implements the improvement plan worked out from a representative short flagship survey and its rendered manuscript. Global constraints below capture the binding requirements extracted from that review and from this codebase's existing conventions.

## Global Constraints

- Every new gate defaults to non-blocking (threshold `0` / disabled) unless explicitly configured in a workspace's `longwrite.yaml`, matching the existing philosophy in `figures.quality_gates` and `research.release_gates` — a new gate must never silently start failing an existing workspace.
- Every new field added to an existing `.strict()` Zod schema must be `.optional()` or carry a `.default(...)` so already-written fixtures and in-flight workspaces keep parsing.
- No new `tool_catalog` actions or `action_dispatch` stages. Route new finding types through the existing four repair capabilities via the `action_plan` planner's metric vocabulary and routing sentences.
- Tests follow this repo's existing convention exactly: Vitest, **no mocking library** (repo-wide, zero `vi.fn`/`vi.mock`/`vi.spyOn` usage), pure functions tested directly against hand-built fixtures, and any filesystem-touching function tested over a real `fs.mkdtemp` temp directory cleaned up in `afterEach`.
- Any change to a compiled stage (adding `landmark_scout`) requires regenerating golden fixtures: `cd packages/longwrite && UPDATE_GOLDEN=1 npm test -- compiled-golden generated-stage-commands`, then a normal `npm test` run to confirm they're now stable.
- Run `npm test` (vitest) and `npm run build` (or the repo's TypeScript check script — confirm exact script name in `packages/longwrite/package.json` before Task 1) after every task; do not proceed to the next task with a red suite.

---

### Task 1: Prose-redundancy gate

**Files:**
- Create: `packages/longwrite/src/lib/research/redundancy.ts`
- Create: `packages/longwrite/tests/redundancy.test.ts`
- Modify: `packages/longwrite/src/lib/project-config.ts` (add two fields to `research.quality_control`)
- Modify: `packages/longwrite/src/lib/validation/research.ts` (add `checkProseRedundancy`, wire into `validateResearchWorkspace`)

**Interfaces:**
- Produces: `computeRedundancy(chapters: Array<{rel: string; content: string}>, opts: {trackedPhrases?: string[]; maxTrackedOccurrences: number; ngramSize?: number; maxNgramOccurrences: number}): RedundancyReport`, where `RedundancyReport = {totalWords: number; trackedPhraseOveruse: PhraseOveruse[]; repeatedNgramOveruse: PhraseOveruse[]}` and `PhraseOveruse = {phrase: string; count: number; sections: string[]}`.
- Consumes (Task 6): nothing new — `checkProseRedundancy` is called from inside `validateResearchWorkspace`, which already builds `chapters: Array<{rel, content}>` via the existing private `chapterFiles()` helper in `research.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/longwrite/tests/redundancy.test.ts
import { describe, expect, it } from "vitest";
import { computeRedundancy } from "../src/lib/research/redundancy.js";

describe("computeRedundancy", () => {
  it("flags a tracked phrase that exceeds its configured maximum across sections", () => {
    const chapters = [
      { rel: "chapters/section-05.md", content: "The available packet does not establish the mechanism. Not specified in packet." },
      { rel: "chapters/section-08.md", content: "The packet again does not establish transfer. Not specified in packet." },
      { rel: "chapters/section-09.md", content: "This packet does not establish provenance." },
    ];
    const report = computeRedundancy(chapters, {
      trackedPhrases: ["packet", "does not establish"],
      maxTrackedOccurrences: 3,
      maxNgramOccurrences: 100,
    });
    const packetFinding = report.trackedPhraseOveruse.find((item) => item.phrase === "packet");
    expect(packetFinding).toBeDefined();
    expect(packetFinding!.count).toBe(5);
    expect(packetFinding!.sections).toEqual(["chapters/section-05.md", "chapters/section-08.md", "chapters/section-09.md"]);
  });

  it("does not flag a phrase within its configured maximum", () => {
    const chapters = [{ rel: "chapters/section-01.md", content: "The packet supports this claim." }];
    const report = computeRedundancy(chapters, { trackedPhrases: ["packet"], maxTrackedOccurrences: 5, maxNgramOccurrences: 100 });
    expect(report.trackedPhraseOveruse).toEqual([]);
  });

  it("flags a repeated five-word phrase spanning multiple sections as a redundant n-gram", () => {
    const repeated = "this establishes a component but not the full loop";
    const chapters = [
      { rel: "chapters/section-a.md", content: repeated },
      { rel: "chapters/section-b.md", content: repeated },
      { rel: "chapters/section-c.md", content: repeated },
    ];
    const report = computeRedundancy(chapters, { maxTrackedOccurrences: 1000, maxNgramOccurrences: 2, ngramSize: 5 });
    expect(report.repeatedNgramOveruse.length).toBeGreaterThan(0);
    expect(report.repeatedNgramOveruse[0]!.sections.length).toBe(3);
  });

  it("does not flag a repeated n-gram confined to a single section", () => {
    const chapters = [{ rel: "chapters/section-a.md", content: "this establishes a component but not the full loop this establishes a component but not the full loop" }];
    const report = computeRedundancy(chapters, { maxTrackedOccurrences: 1000, maxNgramOccurrences: 1, ngramSize: 5 });
    expect(report.repeatedNgramOveruse).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/longwrite && npx vitest run tests/redundancy.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/research/redundancy.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/longwrite/src/lib/research/redundancy.ts

export type PhraseOveruse = { phrase: string; count: number; sections: string[] };

export type RedundancyReport = {
  totalWords: number;
  trackedPhraseOveruse: PhraseOveruse[];
  repeatedNgramOveruse: PhraseOveruse[];
};

const DEFAULT_TRACKED_PHRASES = ["packet", "does not establish", "not specified in packet"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, phrase: string): number {
  const pattern = new RegExp(escapeRegExp(phrase), "gi");
  return (text.match(pattern) ?? []).length;
}

function ngrams(text: string, n: number): string[] {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const grams: string[] = [];
  for (let i = 0; i + n <= words.length; i += 1) grams.push(words.slice(i, i + n).join(" "));
  return grams;
}

export type RedundancyOptions = {
  trackedPhrases?: string[];
  maxTrackedOccurrences: number;
  ngramSize?: number;
  maxNgramOccurrences: number;
};

/** Deterministic prose-redundancy scorer. Tracked phrases catch known caveat
 * boilerplate (configurable per workspace); the n-gram pass catches repeated
 * sentences/fragments across sections that a fixed phrase list would miss. */
export function computeRedundancy(
  chapters: Array<{ rel: string; content: string }>,
  opts: RedundancyOptions,
): RedundancyReport {
  const trackedPhrases = opts.trackedPhrases ?? DEFAULT_TRACKED_PHRASES;
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.content.split(/\s+/).filter(Boolean).length, 0);

  const trackedPhraseOveruse: PhraseOveruse[] = [];
  for (const phrase of trackedPhrases) {
    const sections: string[] = [];
    let count = 0;
    for (const chapter of chapters) {
      const found = countOccurrences(chapter.content, phrase);
      if (found > 0) {
        count += found;
        sections.push(chapter.rel);
      }
    }
    if (count > opts.maxTrackedOccurrences) trackedPhraseOveruse.push({ phrase, count, sections });
  }

  const ngramSize = opts.ngramSize ?? 5;
  const counts = new Map<string, { count: number; sections: Set<string> }>();
  for (const chapter of chapters) {
    for (const gram of ngrams(chapter.content, ngramSize)) {
      const entry = counts.get(gram) ?? { count: 0, sections: new Set<string>() };
      entry.count += 1;
      entry.sections.add(chapter.rel);
      counts.set(gram, entry);
    }
  }
  const repeatedNgramOveruse = [...counts.entries()]
    .filter(([, entry]) => entry.count > opts.maxNgramOccurrences && entry.sections.size > 1)
    .map(([phrase, entry]) => ({ phrase, count: entry.count, sections: [...entry.sections] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return { totalWords, trackedPhraseOveruse, repeatedNgramOveruse };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/longwrite && npx vitest run tests/redundancy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add config fields**

In `packages/longwrite/src/lib/project-config.ts`, extend the `quality_control` object (currently lines 162–167):

```typescript
        quality_control: z
          .object({
            max_improvement_rounds: z.number().int().min(1).max(8).default(3),
            /** 0 disables the gate. Counts tracked phrases (e.g. "packet")
             * summed across all chapters. */
            max_tracked_phrase_occurrences: z.number().int().min(0).max(1_000).default(0),
            /** 0 disables the gate. A 5-gram repeated more than this many
             * times AND spanning more than one section is flagged. */
            max_repeated_ngram_occurrences: z.number().int().min(0).max(1_000).default(0),
          })
          .strict()
          .default({ max_improvement_rounds: 3, max_tracked_phrase_occurrences: 0, max_repeated_ngram_occurrences: 0 }),
```

Also update the top-level `.default({...})` block for `research` (the long inline object around line 208) to include `quality_control: { max_improvement_rounds: 3, max_tracked_phrase_occurrences: 0, max_repeated_ngram_occurrences: 0 }` in place of the current `quality_control: { max_improvement_rounds: 3 }`.

- [ ] **Step 6: Write the failing config test**

```typescript
// add to an existing project-config test file, or create packages/longwrite/tests/project-config-quality-control.test.ts
import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../src/lib/project-config.js";

describe("quality_control redundancy thresholds", () => {
  it("defaults new redundancy thresholds to disabled (0)", () => {
    const config = parseProjectConfig({
      version: 1,
      project: { id: "t", artifact_type: "research_paper", mode: "auto_research_agentic" },
    });
    expect(config.research.quality_control.max_tracked_phrase_occurrences).toBe(0);
    expect(config.research.quality_control.max_repeated_ngram_occurrences).toBe(0);
  });

  it("accepts explicit redundancy thresholds", () => {
    const config = parseProjectConfig({
      version: 1,
      project: { id: "t", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { quality_control: { max_tracked_phrase_occurrences: 15, max_repeated_ngram_occurrences: 3 } },
    });
    expect(config.research.quality_control.max_tracked_phrase_occurrences).toBe(15);
    expect(config.research.quality_control.max_repeated_ngram_occurrences).toBe(3);
  });
});
```

Run: `cd packages/longwrite && npx vitest run tests/project-config-quality-control.test.ts` — expect PASS once Step 5 lands (write this test first if being strict about red/green, but the schema change is small enough that steps 5–6 land together).

- [ ] **Step 7: Wire the gate into `validateResearchWorkspace`**

In `packages/longwrite/src/lib/validation/research.ts`, add the import and function, then splice the check into the `checks` array.

```typescript
// add near the top with other imports
import { computeRedundancy } from "../research/redundancy.js";
```

```typescript
// add as a new function, near checkLiteratureQuality
function checkProseRedundancy(
  chapters: Array<{ rel: string; content: string }>,
  thresholds: { max_tracked_phrase_occurrences: number; max_repeated_ngram_occurrences: number },
): ValidationCheck {
  if (thresholds.max_tracked_phrase_occurrences <= 0 && thresholds.max_repeated_ngram_occurrences <= 0) {
    return { id: "prose_redundancy", pass: true, findings: ["prose redundancy gate is not configured"] };
  }
  const report = computeRedundancy(chapters, {
    maxTrackedOccurrences: thresholds.max_tracked_phrase_occurrences || Number.MAX_SAFE_INTEGER,
    maxNgramOccurrences: thresholds.max_repeated_ngram_occurrences || Number.MAX_SAFE_INTEGER,
  });
  const findings = [
    ...report.trackedPhraseOveruse.map((item) => `prose_redundancy: phrase "${item.phrase}" appears ${item.count} times across ${item.sections.length} section(s) (${item.sections.join(", ")}); configured maximum is ${thresholds.max_tracked_phrase_occurrences}`),
    ...report.repeatedNgramOveruse.map((item) => `prose_redundancy: repeated phrase "${item.phrase}" appears ${item.count} times across ${item.sections.length} sections; configured maximum is ${thresholds.max_repeated_ngram_occurrences}`),
  ];
  return { id: "prose_redundancy", pass: findings.length === 0, findings };
}
```

In `validateResearchWorkspace`, after the `config` is loaded (it already loads `config` inside the try block around line 599–605 — reuse that same loaded value rather than loading twice; refactor that block to keep the resolved config in scope), add to the `checks` array:

```typescript
    configuredProvider === undefined ? { id: "prose_redundancy", pass: true, findings: ["longwrite.yaml unavailable; redundancy gate skipped"] }
      : checkProseRedundancy(chapters, (await loadProjectConfig(workspaceDir)).research.quality_control),
```

(If refactoring the existing `try { const config = await loadProjectConfig(...) } catch {}` block to retain `config` in an outer-scoped variable is cleaner, do that instead of loading twice — follow whatever the surrounding function already does for `configuredProvider`/`requireLiveUrls`.)

- [ ] **Step 8: Run the full validation test suite**

Run: `cd packages/longwrite && npx vitest run tests/redundancy.test.ts tests/project-config-quality-control.test.ts tests/research.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
cd /path/to/MrMaLiang
git add packages/longwrite/src/lib/research/redundancy.ts packages/longwrite/tests/redundancy.test.ts packages/longwrite/src/lib/project-config.ts packages/longwrite/src/lib/validation/research.ts packages/longwrite/tests/project-config-quality-control.test.ts
git commit -m "feat(longwrite): add configurable prose-redundancy gate"
```

---

### Task 2: Diagram-connectivity gate (figure/caption structural match)

**Files:**
- Create: `packages/longwrite/src/lib/research/diagram-connectivity.ts`
- Create: `packages/longwrite/tests/diagram-connectivity.test.ts`
- Modify: `packages/longwrite/src/lib/validation/figures.ts` (add `checkDiagramConnectivity`, wire into `validateFigureWorkspace`)

**Interfaces:**
- Produces: `connectedComponents(spec: DiagramGraphSpec): string[][]` and `isFullyConnected(spec: DiagramGraphSpec): boolean`, where `DiagramGraphSpec = {nodes: Array<{id: string; label: string}>; edges: Array<{from: string; to: string; label?: string}>}`.
- Consumes: reads `figures/placement-plan.json` directly (the authoring-time `PlacementPlan` schema in `src/lib/writing/figures.ts`, which retains `concept_map`/`diagrams[]` node/edge graphs — the final `figures/manifest.json` does NOT retain this graph, only rendered artifact paths, so this check must read the placement plan, not the manifest).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/longwrite/tests/diagram-connectivity.test.ts
import { describe, expect, it } from "vitest";
import { connectedComponents, isFullyConnected } from "../src/lib/research/diagram-connectivity.js";

describe("connectedComponents", () => {
  it("reports one component for a fully connected loop", () => {
    const spec = {
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    };
    expect(connectedComponents(spec)).toHaveLength(1);
    expect(isFullyConnected(spec)).toBe(true);
  });

  it("reports two components for the real short-rsi-survey Figure 1 shape: two disconnected pairs", () => {
    const spec = {
      nodes: [
        { id: "artifact", label: "Artifact / procedure" },
        { id: "iteration", label: "Iteration / state" },
        { id: "evaluation", label: "Evaluation / selection" },
        { id: "later_use", label: "Documented later use" },
      ],
      edges: [
        { from: "artifact", to: "evaluation" },
        { from: "iteration", to: "later_use" },
      ],
    };
    const components = connectedComponents(spec);
    expect(components).toHaveLength(2);
    expect(isFullyConnected(spec)).toBe(false);
  });

  it("treats an isolated node with no edges as its own component", () => {
    const spec = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] };
    expect(connectedComponents(spec)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/longwrite && npx vitest run tests/diagram-connectivity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/longwrite/src/lib/research/diagram-connectivity.ts

export type DiagramGraphSpec = {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
};

/** Union-find over node ids, treating edges as undirected for the purpose of
 * "does this diagram read as one connected system" — a loop drawn with
 * arrows is still one component even though its edges are directional. */
export function connectedComponents(spec: DiagramGraphSpec): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let curr = x;
    while (parent.get(curr) !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const node of spec.nodes) find(node.id);
  for (const edge of spec.edges) {
    find(edge.from);
    find(edge.to);
    union(edge.from, edge.to);
  }
  const groups = new Map<string, string[]>();
  for (const node of spec.nodes) {
    const root = find(node.id);
    const group = groups.get(root) ?? [];
    group.push(node.id);
    groups.set(root, group);
  }
  return [...groups.values()];
}

export function isFullyConnected(spec: DiagramGraphSpec): boolean {
  return connectedComponents(spec).length <= 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/longwrite && npx vitest run tests/diagram-connectivity.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into `validateFigureWorkspace`**

In `packages/longwrite/src/lib/validation/figures.ts`, add:

```typescript
// add near the top with other imports
import { connectedComponents } from "../research/diagram-connectivity.js";

const LOOP_CAPTION_PATTERN = /\b(loop|cycle|feedback|iterative|conjunctive|end-to-end)\b/i;

type PlacementPlanGraphs = {
  concept_map?: { title: string; caption: string; nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string; label?: string }> };
  diagrams?: Array<{ id: string; title: string; caption: string; nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string; label?: string }> }>;
};

/** A caption that promises one connected process (a "loop", "cycle", or
 * "feedback" mechanism) must render as one connected graph. This catches the
 * exact short-rsi-survey defect: a caption describing one conjunctive
 * improvement loop whose rendered diagram is two disconnected chains. */
async function checkDiagramConnectivity(workspaceDir: string): Promise<ValidationCheck> {
  const raw = await readText(workspaceDir, "figures/placement-plan.json");
  if (raw === null) return { id: "diagram_connectivity", pass: true, findings: ["figures/placement-plan.json not present; diagram connectivity check skipped"] };
  let plan: PlacementPlanGraphs;
  try {
    plan = JSON.parse(raw) as PlacementPlanGraphs;
  } catch {
    return { id: "diagram_connectivity", pass: false, findings: ["diagram_connectivity: figures/placement-plan.json is not valid JSON"] };
  }
  const findings: string[] = [];
  const candidates = [
    ...(plan.concept_map ? [{ id: "concept-map", ...plan.concept_map }] : []),
    ...(plan.diagrams ?? []),
  ];
  for (const diagram of candidates) {
    const text = `${diagram.title} ${diagram.caption}`;
    if (!LOOP_CAPTION_PATTERN.test(text)) continue;
    const components = connectedComponents({ nodes: diagram.nodes, edges: diagram.edges });
    if (components.length > 1) {
      findings.push(`diagram_connectivity: ${diagram.id} caption/title implies one connected process ("${text.trim()}") but its rendered graph forms ${components.length} disconnected groups: ${components.map((group) => `[${group.join(", ")}]`).join(", ")}`);
    }
  }
  return { id: "diagram_connectivity", pass: findings.length === 0, findings };
}
```

Then in `validateFigureWorkspace`:

```typescript
export async function validateFigureWorkspace(workspaceDir: string): Promise<ValidationReport> {
  const { check, manifest } = await checkManifest(workspaceDir);
  const checks = [
    check,
    await checkRequiredFullModeVisuals(workspaceDir, manifest),
    await checkArtifacts(workspaceDir, manifest),
    await checkManuscriptReferences(workspaceDir, manifest),
    await checkPublicationLayout(workspaceDir),
    await checkDiagramConnectivity(workspaceDir),
  ];
  return { pass: checks.every((item) => item.pass), checks };
}
```

- [ ] **Step 6: Write an integration-level test against `validateFigureWorkspace`**

```typescript
// add to packages/longwrite/tests/figures.test.ts (or a new packages/longwrite/tests/diagram-connectivity-gate.test.ts if figures.test.ts's existing fixture setup is heavyweight — inspect it first and match its temp-workspace helper)
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFigureWorkspace } from "../src/lib/validation/figures.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

describe("diagram connectivity gate", () => {
  it("fails when a loop-captioned concept map is rendered as disconnected components", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "diagram-connectivity-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      concept_map: {
        title: "The harness improvement loop",
        caption: "One conjunctive improvement loop connecting artifact, iteration, evaluation, and later use.",
        placement: { section_id: "section-01", discussion: "x" },
        nodes: [
          { id: "artifact", label: "Artifact / procedure" },
          { id: "iteration", label: "Iteration / state" },
          { id: "evaluation", label: "Evaluation / selection" },
          { id: "later_use", label: "Documented later use" },
        ],
        edges: [{ from: "artifact", to: "evaluation" }, { from: "iteration", to: "later_use" }],
      },
    }));
    const report = await validateFigureWorkspace(ws);
    const check = report.checks.find((c) => c.id === "diagram_connectivity");
    expect(check?.pass).toBe(false);
    expect(check?.findings[0]).toContain("disconnected groups");
  });

  it("passes when the concept map is fully connected", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "diagram-connectivity-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      concept_map: {
        title: "The harness improvement loop",
        caption: "One conjunctive improvement loop.",
        placement: { section_id: "section-01", discussion: "x" },
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
      },
    }));
    const report = await validateFigureWorkspace(ws);
    const check = report.checks.find((c) => c.id === "diagram_connectivity");
    expect(check?.pass).toBe(true);
  });
});
```

Before writing this step, run `cat packages/longwrite/tests/figures.test.ts | head -60` to confirm the existing fixture-workspace helper shape, and reuse it if one already builds a minimal valid workspace — don't duplicate a helper that already exists.

- [ ] **Step 7: Run tests**

Run: `cd packages/longwrite && npx vitest run tests/diagram-connectivity.test.ts tests/figures.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add packages/longwrite/src/lib/research/diagram-connectivity.ts packages/longwrite/tests/diagram-connectivity.test.ts packages/longwrite/src/lib/validation/figures.ts packages/longwrite/tests/figures.test.ts
git commit -m "feat(longwrite): fail the release gate when a loop-captioned diagram renders as disconnected components"
```

---

### Task 3: System-card evidence fields + packet-language ban

**Files:**
- Modify: `packages/longwrite/src/lib/research/semantic-screen.ts` (extend `SourceEvidenceClaim`, extend `repairSourceEvidencePackets`)
- Modify: `packages/longwrite/configs/modes/auto_research_agentic.yaml` (extend `source_evidence_extract` instructions, extend `draft_sections`/`draft` step instructions with the packet-language ban)
- Create: `packages/longwrite/tests/system-card-fields.test.ts`

**Interfaces:**
- Produces: `SourceEvidenceClaim` gains optional fields `modified_object`, `proposer_or_improver`, `evaluation_mechanism`, `persistence_scope`, `later_use`, `cross_task_transfer`, `meta_improvement`, `human_oversight`, `sandbox_rollback_provenance`, `benchmarks`, each using a shared `EvidenceStatus` enum `"demonstrated" | "partial" | "reported_without_evaluation" | "not_reported" | "not_applicable" | "contradicted"` where applicable.

- [ ] **Step 1: Locate the exact `source_evidence_extract` stage text**

```bash
cd packages/longwrite && grep -n "source_evidence_extract\|SourceEvidenceClaim" src/workflow/composition.ts src/lib/research/semantic-screen.ts | head -20
```

Read the matched region of `composition.ts` (the `source_evidence_extract` agentStage, and its quality-loop refresh sibling `quality_source_evidence_extract`) before editing, so the new instruction line is inserted into the real `instructions` array rather than guessed.

- [ ] **Step 2: Extend the Zod schema (write the failing test first)**

```typescript
// packages/longwrite/tests/system-card-fields.test.ts
import { describe, expect, it } from "vitest";
import { SourceEvidencePackets } from "../src/lib/research/semantic-screen.js";

describe("system-card fields on SourceEvidenceClaim", () => {
  it("accepts a claim with system-card status fields", () => {
    const parsed = SourceEvidencePackets.parse({
      version: 1,
      packets: [{
        source_id: "s1",
        recommended_depth: "A",
        claims: [{
          claim: "The system modifies its own agent code and evaluates the modification empirically.",
          supporting_excerpt: "the agent modifies its own scaffolding code and evaluates the change against a benchmark",
          locator: "p4",
          modified_object: "agent scaffolding code",
          proposer_or_improver: "the agent itself, via an LLM-generated patch",
          evaluation_mechanism: "benchmark suite execution",
          persistence_scope: "archived variant reused in later iterations",
          later_use: "demonstrated",
          cross_task_transfer: "not_reported",
          meta_improvement: "partial",
          human_oversight: "none described",
          sandbox_rollback_provenance: "archive keeps prior variants; no explicit rollback trigger",
          benchmarks: ["SWE-bench subset"],
        }],
      }],
    });
    expect(parsed.packets[0]!.claims[0]!.later_use).toBe("demonstrated");
  });

  it("still accepts a claim with none of the new optional fields (backward compatible)", () => {
    const parsed = SourceEvidencePackets.parse({
      version: 1,
      packets: [{
        source_id: "s1",
        recommended_depth: "B",
        claims: [{ claim: "A claim with only the original required fields present here.", supporting_excerpt: "an excerpt long enough to pass validation", locator: "p1" }],
      }],
    });
    expect(parsed.packets[0]!.claims[0]!.later_use).toBeUndefined();
  });

  it("rejects an invalid later_use value", () => {
    expect(() => SourceEvidencePackets.parse({
      version: 1,
      packets: [{
        source_id: "s1",
        recommended_depth: "A",
        claims: [{ claim: "A claim with an invalid status enum value set here.", supporting_excerpt: "an excerpt long enough to pass validation", locator: "p1", later_use: "sort_of" }],
      }],
    })).toThrow();
  });
});
```

Run: `cd packages/longwrite && npx vitest run tests/system-card-fields.test.ts`
Expected: FAIL — `later_use` etc. are not recognized by the current `.strict()` schema (Zod strict mode rejects unknown keys).

- [ ] **Step 3: Implement the schema extension**

In `packages/longwrite/src/lib/research/semantic-screen.ts`, replace the current `SourceEvidenceClaim` definition (currently lines 64–70):

```typescript
const EvidenceStatus = z.enum(["demonstrated", "partial", "reported_without_evaluation", "not_reported", "not_applicable", "contradicted"]);

const SourceEvidenceClaim = z.object({
  claim: z.string().min(12).max(1_000),
  supporting_excerpt: z.string().min(12).max(700),
  locator: z.string().min(1).max(300),
  comparison_dimensions: z.array(z.string().min(2).max(160)).max(8).default([]),
  limitations: z.array(z.string().min(4).max(500)).max(8).default([]),
  /** System-card fields. All optional so existing packets remain valid; a
   * claim about a candidate self-improvement system should populate the
   * ones it can support from full-text evidence, not leave every field off
   * because the extracted excerpt was short. */
  modified_object: z.string().min(2).max(200).optional(),
  proposer_or_improver: z.string().min(2).max(200).optional(),
  evaluation_mechanism: z.string().min(2).max(300).optional(),
  persistence_scope: z.string().min(2).max(300).optional(),
  later_use: EvidenceStatus.optional(),
  cross_task_transfer: EvidenceStatus.optional(),
  meta_improvement: EvidenceStatus.optional(),
  human_oversight: z.string().min(2).max(300).optional(),
  sandbox_rollback_provenance: z.string().min(2).max(300).optional(),
  benchmarks: z.array(z.string().min(2).max(200)).max(8).default([]),
}).strict();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/longwrite && npx vitest run tests/system-card-fields.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for the repair-time nudge**

```typescript
// append to packages/longwrite/tests/system-card-fields.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { repairSourceEvidencePackets, SOURCE_EVIDENCE_CANDIDATES_PATH, SOURCE_EVIDENCE_PATH } from "../src/lib/research/semantic-screen.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

async function buildWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "system-card-"));
  tempDirs.push(ws);
  await fs.mkdir(path.join(ws, "fulltext"), { recursive: true });
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "evidence"), { recursive: true });
  const fulltext = "The agent modifies its own scaffolding code and evaluates the change against a benchmark suite before promoting it.";
  await fs.writeFile(path.join(ws, "fulltext", "s1.txt"), fulltext);
  await fs.writeFile(path.join(ws, SOURCE_EVIDENCE_CANDIDATES_PATH), JSON.stringify({
    candidates: [{ id: "s1", title: "Example System", fulltext_path: "fulltext/s1.txt" }],
  }));
  await fs.writeFile(path.join(ws, "longwrite.yaml"), [
    "version: 1",
    "project:",
    "  id: t",
    "  artifact_type: research_paper",
    "  mode: auto_research_agentic",
  ].join("\n"));
  return ws;
}

it("rejects an A-depth packet whose claims record no system-improvement status field", async () => {
  const ws = await buildWorkspace();
  await fs.writeFile(path.join(ws, SOURCE_EVIDENCE_PATH), JSON.stringify({
    version: 1,
    packets: [{
      source_id: "s1",
      recommended_depth: "A",
      claims: [
        { claim: "The agent modifies its own scaffolding code before promotion.", supporting_excerpt: "modifies its own scaffolding code and evaluates the change", locator: "p1" },
        { claim: "The change is evaluated against a benchmark suite before use.", supporting_excerpt: "evaluates the change against a benchmark suite before promoting", locator: "p1" },
      ],
    }],
  }));
  await expect(repairSourceEvidencePackets(ws)).rejects.toThrow(/later_use\/cross_task_transfer\/meta_improvement/);
});

it("accepts an A-depth packet once at least one claim records a system-improvement status field", async () => {
  const ws = await buildWorkspace();
  await fs.writeFile(path.join(ws, SOURCE_EVIDENCE_PATH), JSON.stringify({
    version: 1,
    packets: [{
      source_id: "s1",
      recommended_depth: "A",
      claims: [
        { claim: "The agent modifies its own scaffolding code before promotion.", supporting_excerpt: "modifies its own scaffolding code and evaluates the change", locator: "p1", later_use: "demonstrated" },
        { claim: "The change is evaluated against a benchmark suite before use.", supporting_excerpt: "evaluates the change against a benchmark suite before promoting", locator: "p1" },
      ],
    }],
  }));
  await expect(repairSourceEvidencePackets(ws)).resolves.toMatchObject({ normalized: false });
});
```

Run: `cd packages/longwrite && npx vitest run tests/system-card-fields.test.ts`
Expected: FAIL on the new rejection test (current `repairSourceEvidencePackets` has no such check yet).

- [ ] **Step 6: Implement the repair-time nudge**

In `repairSourceEvidencePackets` (`semantic-screen.ts`), inside the `for (const claim of packet.claims)` loop, after the existing excerpt/word-count/claim-bearing checks, add:

```typescript
        if (packet.recommended_depth !== "C" && claims_lack_status(packet)) {
          throw new Error(`packet ${packet.source_id} claims record no later_use/cross_task_transfer/meta_improvement status; A/B-depth system cards must record at least one system-improvement status field, using not_reported only after inspecting the full text, not because the extracted excerpt was short`);
        }
```

Add the helper above `repairSourceEvidencePackets`:

```typescript
function claims_lack_status(packet: { claims: Array<{ later_use?: string; cross_task_transfer?: string; meta_improvement?: string }> }): boolean {
  return packet.claims.every((claim) => claim.later_use === undefined && claim.cross_task_transfer === undefined && claim.meta_improvement === undefined);
}
```

(Rename `claims_lack_status` to match this file's existing camelCase convention, e.g. `packetLacksSystemCardStatus`, when implementing — the plan uses the descriptive name for clarity but the codebase is camelCase throughout.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/longwrite && npx vitest run tests/system-card-fields.test.ts`
Expected: PASS (5 tests total)

- [ ] **Step 8: Ban "packet" from reader-facing prose instructions**

```bash
cd packages/longwrite && grep -n "id: draft_sections" -A 5 configs/modes/auto_research_agentic.yaml
grep -n "^\s*- id: draft$" configs/modes/auto_research_agentic.yaml
```

Read the matched `draft` step's `instructions` array (inside `draft_sections`'s `steps`) and append this line to it:

```yaml
            - "Never use the word \"packet\" (or \"evidence packet\", \"supplied packet\") in manuscript prose. When evidence is absent, write \"not reported by the cited source\" or \"outside this paper's scope,\" grounded in the claim's later_use/cross_task_transfer/meta_improvement status field — never a description of what the extraction pipeline happened to contain."
```

Also extend the `source_evidence_extract` agentStage's `instructions` (found in Step 1) with:

```yaml
            - "For each claim, additionally record modified_object, proposer_or_improver, evaluation_mechanism, persistence_scope, later_use, cross_task_transfer, meta_improvement, human_oversight, sandbox_rollback_provenance, and benchmarks where the full text supports them. Set later_use/cross_task_transfer/meta_improvement to not_reported only after checking the full text for that information, never merely because this excerpt omitted it."
```

Apply the same two additions to `quality_source_evidence_extract` (the quality-loop refresh sibling found via the same grep).

- [ ] **Step 9: Regenerate compiled-workflow golden fixtures**

Run: `cd packages/longwrite && UPDATE_GOLDEN=1 npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts`
Then: `npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts`
Expected: second run PASSES with the regenerated fixtures now committed as the new baseline. Diff the fixture changes (`git diff -- tests/fixtures/compiled/`) and confirm only the expected instruction-text additions changed, not stage structure.

- [ ] **Step 10: Run the full suite**

Run: `cd packages/longwrite && npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/longwrite/src/lib/research/semantic-screen.ts packages/longwrite/tests/system-card-fields.test.ts packages/longwrite/configs/modes/auto_research_agentic.yaml packages/longwrite/tests/fixtures/compiled/
git commit -m "feat(longwrite): add system-card evidence fields and ban packet-language from manuscript prose"
```

---

### Task 4: Cross-section contradiction detection

**Files:**
- Create: `packages/longwrite/src/lib/research/contradiction.ts`
- Create: `packages/longwrite/tests/contradiction.test.ts`
- Modify: `packages/longwrite/configs/modes/auto_research_agentic.yaml` (extend `claim_judge` stage, lines 580–599, exact text already verified)
- Modify: `packages/longwrite/src/lib/validation/research.ts` (add `checkNoContradictions`, wire in)

**Interfaces:**
- Produces: `detectContradictions(judgments: ClaimJudgment[]): ContradictionGroup[]`, where `ClaimJudgment = {sample_id: string; reviewer_id: string; source_id: string; chapter: string; claim: string; subject_key?: string; polarity?: "affirms" | "denies" | "qualifies"; verdict: string}` and `ContradictionGroup = {subject_key: string; chapters: string[]; claims: ClaimJudgment[]}`.
- Consumes: `reviews/claim-judgments.jsonl`, already produced by the existing `claim_judge` stage — this task only adds two new required fields to that stage's output contract.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/longwrite/tests/contradiction.test.ts
import { describe, expect, it } from "vitest";
import { detectContradictions, type ClaimJudgment } from "../src/lib/research/contradiction.js";

const j = (over: Partial<ClaimJudgment>): ClaimJudgment => ({
  sample_id: "claim-001", reviewer_id: "reviewer_a", source_id: "s1", chapter: "chapters/section-05.md",
  claim: "example claim", verdict: "entailed", ...over,
});

describe("detectContradictions", () => {
  it("flags the same subject affirmed in one section and denied in another", () => {
    const judgments = [
      j({ chapter: "chapters/section-05.md", claim: "The stale constraint is withdrawn by a newer authoritative record.", subject_key: "stale-constraint-provenance-mechanism", polarity: "affirms" }),
      j({ chapter: "chapters/section-08.md", claim: "Provenance linking substantially improved current-record-consistent decisions.", subject_key: "stale-constraint-provenance-mechanism", polarity: "affirms" }),
      j({ chapter: "chapters/section-09.md", claim: "The supplied evidence does not establish a withdrawn constraint or provenance-preserved origin.", subject_key: "stale-constraint-provenance-mechanism", polarity: "denies" }),
    ];
    const contradictions = detectContradictions(judgments);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.subject_key).toBe("stale-constraint-provenance-mechanism");
    expect(contradictions[0]!.chapters.sort()).toEqual(["chapters/section-05.md", "chapters/section-08.md", "chapters/section-09.md"]);
  });

  it("does not flag two qualifications of the same subject as a contradiction", () => {
    const judgments = [
      j({ chapter: "chapters/section-03.md", subject_key: "memory-persistence", polarity: "qualifies" }),
      j({ chapter: "chapters/section-06.md", subject_key: "memory-persistence", polarity: "qualifies" }),
    ];
    expect(detectContradictions(judgments)).toEqual([]);
  });

  it("does not flag an affirm/deny pair confined to a single section", () => {
    const judgments = [
      j({ chapter: "chapters/section-03.md", subject_key: "x", polarity: "affirms" }),
      j({ chapter: "chapters/section-03.md", subject_key: "x", polarity: "denies" }),
    ];
    expect(detectContradictions(judgments)).toEqual([]);
  });

  it("ignores judgments missing subject_key or polarity", () => {
    const judgments = [j({ subject_key: undefined, polarity: undefined })];
    expect(detectContradictions(judgments)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/longwrite && npx vitest run tests/contradiction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/longwrite/src/lib/research/contradiction.ts

export type ClaimJudgment = {
  sample_id: string;
  reviewer_id: string;
  source_id: string;
  chapter: string;
  claim: string;
  subject_key?: string;
  polarity?: "affirms" | "denies" | "qualifies";
  verdict: string;
};

export type ContradictionGroup = { subject_key: string; chapters: string[]; claims: ClaimJudgment[] };

/** Groups double-reviewed sampled claims by their normalized subject_key and
 * flags a group as contradictory only when it contains both an "affirms" and
 * a "denies" polarity spanning more than one chapter. Two sections both
 * qualifying the same claim is caution, not conflict, and is deliberately
 * not flagged. */
export function detectContradictions(judgments: ClaimJudgment[]): ContradictionGroup[] {
  const bySubject = new Map<string, ClaimJudgment[]>();
  for (const judgment of judgments) {
    if (!judgment.subject_key || !judgment.polarity) continue;
    const group = bySubject.get(judgment.subject_key) ?? [];
    group.push(judgment);
    bySubject.set(judgment.subject_key, group);
  }
  const contradictions: ContradictionGroup[] = [];
  for (const [subject_key, claims] of bySubject) {
    const polarities = new Set(claims.map((claim) => claim.polarity));
    const chapters = new Set(claims.map((claim) => claim.chapter));
    if (polarities.has("affirms") && polarities.has("denies") && chapters.size > 1) {
      contradictions.push({ subject_key, chapters: [...chapters], claims });
    }
  }
  return contradictions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/longwrite && npx vitest run tests/contradiction.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Extend the `claim_judge` stage's output contract**

In `packages/longwrite/configs/modes/auto_research_agentic.yaml`, replace lines 591–592 (the two instruction strings) with:

```yaml
            - "Deterministically sample substantive cited claims from every section. Use stable sample ids like claim-001."
            - "Write reviews/claim-judgments.jsonl with TWO independent JSONL judgments per sample_id, reviewer_id values reviewer_a and reviewer_b, and fields {sample_id,reviewer_id,source_id,chapter,claim,evidence_locators,prompt_hash,model,runtime,verdict,rationale,subject_key,polarity}. verdict must be entailed, partial, or unsupported."
            - "subject_key is a short, normalized lowercase-hyphenated id naming the specific real-world mechanism or finding the claim is about (e.g. \"stale-constraint-provenance-mechanism\"), not the source or the chapter. Two claims about the same mechanism MUST share the same subject_key even when worded differently, so contradictions across sections can be detected automatically. polarity is affirms, denies, or qualifies: affirms asserts the mechanism holds, denies asserts the evidence cannot establish it or that it does not hold, qualifies neither affirms nor denies but narrows scope."
            - "Judge the exact evidence packet/chunk locators, not source metadata. Any disagreement must be routed to human review or revision before release."
```

- [ ] **Step 6: Write the failing gate test**

```typescript
// add to packages/longwrite/tests/contradiction.test.ts, or a new packages/longwrite/tests/contradiction-gate.test.ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

describe("claim_contradictions release gate", () => {
  it("fails when reviews/claim-judgments.jsonl records an affirm/deny pair across sections", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "contradiction-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "claim-judgments.jsonl"), [
      JSON.stringify({ sample_id: "claim-001", reviewer_id: "reviewer_a", source_id: "s1", chapter: "chapters/section-05.md", claim: "affirms it", verdict: "entailed", subject_key: "stale-constraint", polarity: "affirms" }),
      JSON.stringify({ sample_id: "claim-002", reviewer_id: "reviewer_a", source_id: "s2", chapter: "chapters/section-09.md", claim: "denies it", verdict: "unsupported", subject_key: "stale-constraint", polarity: "denies" }),
    ].join("\n"));
    const report = await validateResearchWorkspace(ws);
    const check = report.checks.find((c) => c.id === "claim_contradictions");
    expect(check?.pass).toBe(false);
    expect(check?.findings[0]).toContain("stale-constraint");
  });
});
```

Run: `cd packages/longwrite && npx vitest run tests/contradiction.test.ts` (or the new file)
Expected: FAIL — no `claim_contradictions` check exists yet in `validateResearchWorkspace`'s output.

- [ ] **Step 7: Wire the gate into `validateResearchWorkspace`**

In `packages/longwrite/src/lib/validation/research.ts`:

```typescript
// add import
import { detectContradictions, type ClaimJudgment } from "../research/contradiction.js";

// add function
async function checkNoContradictions(workspaceDir: string): Promise<ValidationCheck> {
  const result = await readJsonlFile<ClaimJudgment>(workspaceDir, "reviews/claim-judgments.jsonl");
  if (result.error) return { id: "claim_contradictions", pass: true, findings: ["no claim judgments found; contradiction check skipped"] };
  const contradictions = detectContradictions(result.rows);
  const findings = contradictions.map((group) =>
    `claim_contradictions: subject "${group.subject_key}" is both affirmed and denied across ${group.chapters.join(", ")}: ${group.claims.map((claim) => `[${claim.chapter}] ${claim.polarity}: ${claim.claim}`).join(" | ")}`,
  );
  return { id: "claim_contradictions", pass: findings.length === 0, findings };
}
```

Add `await checkNoContradictions(workspaceDir),` to the `checks` array inside `validateResearchWorkspace` (near `await checkClaimSupport(workspaceDir),`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/longwrite && npx vitest run tests/contradiction.test.ts tests/claim-gate.test.ts tests/research.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 9: Regenerate golden fixtures**

Run: `cd packages/longwrite && UPDATE_GOLDEN=1 npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts && npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts`

- [ ] **Step 10: Commit**

```bash
git add packages/longwrite/src/lib/research/contradiction.ts packages/longwrite/tests/contradiction.test.ts packages/longwrite/configs/modes/auto_research_agentic.yaml packages/longwrite/src/lib/validation/research.ts packages/longwrite/tests/fixtures/compiled/
git commit -m "feat(longwrite): detect cross-section claim contradictions from double-reviewed samples"
```

---

### Task 5: Landmark-scout stage + landmark-coverage gate

**Files:**
- Create: `packages/longwrite/src/lib/research/landmark.ts`
- Create: `packages/longwrite/tests/landmark.test.ts`
- Modify: `packages/longwrite/configs/modes/auto_research_agentic.yaml` (new `landmark_scout` stage)
- Modify: `packages/longwrite/src/lib/project-config.ts` (add `min_landmark_coverage_ratio` to `research.corpus_gates`)
- Modify: `packages/longwrite/src/lib/validation/research.ts` (add `checkLandmarkCoverage`, wire in)

**Interfaces:**
- Produces: `matchLandmarksToCorpus(candidates, sources): LandmarkMatch[]` and `computeLandmarkCoverage(matches): LandmarkCoverageResult`, where `LandmarkCandidates = {version: 1; candidates: Array<{name: string; why_canonical: string; expected_identifiers?: {arxiv_id?: string; doi?: string}; confidence: "high"|"medium"|"low"}>}` (Zod-validated) and `LandmarkCoverageResult = {total: number; matched: number; coverageRatio: number; unmatched: string[]}`.
- Consumes: `ClassifiedSource` type from `src/lib/research/types.ts` (fields used: `id`, `title`, `identifiers.arxiv_id`, `identifiers.doi`).

- [ ] **Step 1: Write the failing test for the pure matching/scoring logic**

```typescript
// packages/longwrite/tests/landmark.test.ts
import { describe, expect, it } from "vitest";
import { LandmarkCandidates, matchLandmarksToCorpus, computeLandmarkCoverage } from "../src/lib/research/landmark.js";
import type { ClassifiedSource } from "../src/lib/research/types.js";

const source = (over: Partial<ClassifiedSource>): ClassifiedSource => ({
  id: "s1", title: "Untitled", authors: [], year: 2025, venue: "arXiv", url: "https://example.com",
  abstract: "", source: "arxiv", topics: [], citation_depth: "B", citation_depth_rationale: "",
  ...over,
} as ClassifiedSource);

describe("landmark matching and coverage", () => {
  it("matches a landmark by exact arxiv_id", () => {
    const candidates = LandmarkCandidates.parse({
      version: 1,
      candidates: [{ name: "Darwin Godel Machine", why_canonical: "Iteratively modifies its own agent code and evaluates changes empirically.", expected_identifiers: { arxiv_id: "2505.22954" }, confidence: "high" }],
    }).candidates;
    const sources = [source({ id: "dgm", title: "The Darwin Godel Machine", identifiers: { arxiv_id: "2505.22954" } })];
    const matches = matchLandmarksToCorpus(candidates, sources);
    expect(matches[0]!.matchedSourceId).toBe("dgm");
    expect(matches[0]!.matchedBy).toBe("identifier");
  });

  it("matches a landmark by normalized title when no identifier is supplied", () => {
    const candidates = LandmarkCandidates.parse({
      version: 1,
      candidates: [{ name: "Promptbreeder", why_canonical: "Evolves both task prompts and the mutation prompts that improve them.", confidence: "medium" }],
    }).candidates;
    const sources = [source({ id: "pb", title: "Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution" })];
    const matches = matchLandmarksToCorpus(candidates, sources);
    expect(matches[0]!.matchedSourceId).toBe("pb");
    expect(matches[0]!.matchedBy).toBe("title");
  });

  it("leaves a landmark unmatched when absent from the corpus", () => {
    const candidates = LandmarkCandidates.parse({
      version: 1,
      candidates: [{ name: "AFlow", why_canonical: "Searches over code-represented agent workflows with execution feedback.", confidence: "high" }],
    }).candidates;
    const matches = matchLandmarksToCorpus(candidates, []);
    expect(matches[0]!.matchedSourceId).toBeNull();
  });

  it("computes coverage ratio and lists unmatched candidate names", () => {
    const matches = [
      { candidate: "A", matchedSourceId: "s1", matchedBy: "identifier" as const },
      { candidate: "B", matchedSourceId: null, matchedBy: null },
    ];
    const coverage = computeLandmarkCoverage(matches);
    expect(coverage.coverageRatio).toBe(0.5);
    expect(coverage.unmatched).toEqual(["B"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/longwrite && npx vitest run tests/landmark.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/longwrite/src/lib/research/landmark.ts
import { z } from "zod";
import type { ClassifiedSource } from "./types.js";

export const LandmarkCandidate = z.object({
  name: z.string().min(1).max(200),
  why_canonical: z.string().min(20).max(600),
  expected_identifiers: z.object({
    arxiv_id: z.string().min(1).optional(),
    doi: z.string().min(1).optional(),
  }).strict().optional(),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

export const LandmarkCandidates = z.object({
  version: z.literal(1),
  candidates: z.array(LandmarkCandidate).min(1).max(30),
}).strict();
export type LandmarkCandidates = z.infer<typeof LandmarkCandidates>;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export type LandmarkMatch = { candidate: string; matchedSourceId: string | null; matchedBy: "identifier" | "title" | null };

/** Identifier matches are exact and unambiguous. Title matches fall back to a
 * substring check on normalized text, sufficient for a short-title landmark
 * work (e.g. "AFlow", "Promptbreeder") without requiring exact title casing
 * or venue suffixes to line up. */
export function matchLandmarksToCorpus(
  candidates: LandmarkCandidates["candidates"],
  sources: ClassifiedSource[],
): LandmarkMatch[] {
  return candidates.map((candidate) => {
    const arxivId = candidate.expected_identifiers?.arxiv_id;
    const doi = candidate.expected_identifiers?.doi;
    if (arxivId) {
      const bySource = sources.find((source) => source.identifiers?.arxiv_id === arxivId);
      if (bySource) return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const };
    }
    if (doi) {
      const bySource = sources.find((source) => source.identifiers?.doi === doi);
      if (bySource) return { candidate: candidate.name, matchedSourceId: bySource.id, matchedBy: "identifier" as const };
    }
    const normalizedName = normalize(candidate.name);
    const byTitle = sources.find((source) => {
      const normalizedTitle = normalize(source.title);
      return normalizedTitle.length > 0 && (normalizedTitle.includes(normalizedName) || normalizedName.includes(normalizedTitle));
    });
    if (byTitle) return { candidate: candidate.name, matchedSourceId: byTitle.id, matchedBy: "title" as const };
    return { candidate: candidate.name, matchedSourceId: null, matchedBy: null };
  });
}

export type LandmarkCoverageResult = { total: number; matched: number; coverageRatio: number; unmatched: string[] };

export function computeLandmarkCoverage(matches: LandmarkMatch[]): LandmarkCoverageResult {
  const matched = matches.filter((match) => match.matchedSourceId !== null);
  return {
    total: matches.length,
    matched: matched.length,
    coverageRatio: matches.length === 0 ? 1 : matched.length / matches.length,
    unmatched: matches.filter((match) => match.matchedSourceId === null).map((match) => match.candidate),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/longwrite && npx vitest run tests/landmark.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the config field**

In `packages/longwrite/src/lib/project-config.ts`, extend `corpus_gates` (currently lines 185–194):

```typescript
        corpus_gates: z
          .object({
            min_candidates: z.number().int().min(1).max(2_000).default(200),
            min_sources_per_taxonomy_cell: z.number().int().min(0).max(100).default(3),
            min_core_sources: z.number().int().min(0).max(500).default(20),
            min_recent_ratio: Ratio.default(0.25),
            min_source_type_diversity: z.number().int().min(1).max(10).default(3),
            /** 0 disables the gate. Fraction of research/landmark-candidates.json
             * entries matched (by identifier or title) in classified_sources. */
            min_landmark_coverage_ratio: Ratio.default(0),
          })
          .strict()
          .default({ min_candidates: 200, min_sources_per_taxonomy_cell: 3, min_core_sources: 20, min_recent_ratio: 0.25, min_source_type_diversity: 3, min_landmark_coverage_ratio: 0 }),
```

Update the outer `.default({...research...})` block's `corpus_gates` entry to match (add `min_landmark_coverage_ratio: 0`).

- [ ] **Step 6: Write the failing gate test**

```typescript
// append to packages/longwrite/tests/landmark.test.ts
import { afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

describe("landmark_coverage release gate", () => {
  it("fails when configured coverage is below threshold and reports missing candidates", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "landmark-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "research"), { recursive: true });
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), [
      "version: 1",
      "project:", "  id: t", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  corpus_gates:", "    min_landmark_coverage_ratio: 0.8",
    ].join("\n"));
    await fs.writeFile(path.join(ws, "research", "landmark-candidates.json"), JSON.stringify({
      version: 1,
      candidates: [
        { name: "Darwin Godel Machine", why_canonical: "Iteratively modifies its own agent code and evaluates changes empirically.", confidence: "high" },
        { name: "AFlow", why_canonical: "Searches over code-represented agent workflows with execution feedback.", confidence: "high" },
      ],
    }));
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "");
    const report = await validateResearchWorkspace(ws);
    const check = report.checks.find((c) => c.id === "landmark_coverage");
    expect(check?.pass).toBe(false);
    expect(check?.findings[0]).toContain("Darwin Godel Machine");
  });
});
```

Run: `cd packages/longwrite && npx vitest run tests/landmark.test.ts`
Expected: FAIL — no `landmark_coverage` check exists yet.

- [ ] **Step 7: Wire the gate into `validateResearchWorkspace`**

In `packages/longwrite/src/lib/validation/research.ts`:

```typescript
// add import
import { LandmarkCandidates, matchLandmarksToCorpus, computeLandmarkCoverage } from "../research/landmark.js";

// add function
async function checkLandmarkCoverage(workspaceDir: string, sources: ClassifiedSource[]): Promise<ValidationCheck> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  const threshold = config?.research.corpus_gates.min_landmark_coverage_ratio ?? 0;
  if (threshold <= 0) return { id: "landmark_coverage", pass: true, findings: ["landmark coverage gate is not configured"] };
  const raw = await readIfExists(path.join(workspaceDir, "research", "landmark-candidates.json"));
  if (raw === null) return { id: "landmark_coverage", pass: false, findings: ["landmark_coverage: research/landmark-candidates.json is required when min_landmark_coverage_ratio is configured; run the landmark_scout stage"] };
  let candidates: LandmarkCandidates;
  try {
    candidates = LandmarkCandidates.parse(JSON.parse(raw));
  } catch (error) {
    return { id: "landmark_coverage", pass: false, findings: [`landmark_coverage: research/landmark-candidates.json is invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const matches = matchLandmarksToCorpus(candidates.candidates, sources);
  const coverage = computeLandmarkCoverage(matches);
  if (coverage.coverageRatio >= threshold) {
    return { id: "landmark_coverage", pass: true, findings: [`landmark_coverage: ${coverage.matched}/${coverage.total} landmark works matched in the corpus`] };
  }
  return {
    id: "landmark_coverage",
    pass: false,
    findings: [`landmark_coverage: coverage ratio ${coverage.coverageRatio.toFixed(3)} (${coverage.matched}/${coverage.total}) is below configured minimum ${threshold.toFixed(3)}; missing: ${coverage.unmatched.join(", ")}`],
  };
}
```

Add `await checkLandmarkCoverage(workspaceDir, sources),` to the `checks` array in `validateResearchWorkspace`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/longwrite && npx vitest run tests/landmark.test.ts`
Expected: PASS (5 tests total)

- [ ] **Step 9: Locate the anchor for the new stage and verify the JSON-output validator id**

```bash
cd packages/longwrite && grep -n "id: search_planner\|id: recall\b" configs/modes/auto_research_agentic.yaml
grep -rn "\"json_parseable\"\|'json_parseable'\|jsonl_parseable" src/ | grep -i valida
```

Confirm the exact stage id immediately preceding broad recall (the plan assumes `search_planner`) and the exact validator id for a JSON (not JSONL) output — `required_output_exists` alone is sufficient if no dedicated JSON-shape validator exists; do not invent a validator id that grep does not confirm.

- [ ] **Step 10: Add the `landmark_scout` stage**

Also confirm the exact filename the `specify` phase writes (grep `research/brief` or similar) — the block below assumes `research/brief.md` based on the architecture doc's description ("turn product inputs into a brief and search strategy"); replace `research/brief.md` with the real path if grep shows otherwise, or fall back to `longwrite.yaml`'s `research.topic` field (already loaded by every LLM stage via the project config) if no separate brief file exists at this point in the pipeline.

In `configs/modes/auto_research_agentic.yaml`, insert immediately before the `search_planner` stage found in Step 9:

```yaml
        - id: landmark_scout
          title: Identify canonical works for this topic before broad recall
          owner: search-strategist
          inputs:
            - research/brief.md
          outputs:
            - research/landmark-candidates.json
          instructions:
            - "Before any broad literature search runs, name the specific canonical or landmark works a domain expert would expect this exact paper to engage with: foundational terminology sources, seminal papers, the most important recent high-impact systems, key surveys, and known counterexamples. Generate these dynamically from the topic and brief — never reuse a fixed list carried over from a different paper's topic."
            - "Write ONLY research/landmark-candidates.json: {version:1,candidates:[{name,why_canonical,expected_identifiers?:{arxiv_id?,doi?},confidence:high|medium|low}]}. Name real, verifiable works only; omit expected_identifiers rather than inventing one when uncertain of the exact id. List 5 to 30 candidates ordered by confidence."
          outputs:
            - research/landmark-candidates.json
          validators:
            - required_output_exists
```

(Remove the duplicated `outputs:` key shown above — it is listed once for clarity here; write it once in the actual YAML, matching the shape of the neighboring `visual_plan` stage at lines 271–285.)

- [ ] **Step 11: Add `landmark_scout` to `execution.stage_overrides` documentation and confirm it compiles**

```bash
cd packages/longwrite && npm run build 2>&1 | head -50
UPDATE_GOLDEN=1 npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts
npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts
```

Expected: build succeeds; golden tests pass after regeneration. Confirm `landmark_scout` appears as a top-level stage id in the regenerated fixture and is overridable via `execution.stage_overrides.landmark_scout` (per `applyStageOverrides`'s generic id-matching — no code change needed for override support since it matches any compiled stage id automatically).

- [ ] **Step 12: Run the full suite**

Run: `cd packages/longwrite && npm test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/longwrite/src/lib/research/landmark.ts packages/longwrite/tests/landmark.test.ts packages/longwrite/configs/modes/auto_research_agentic.yaml packages/longwrite/src/lib/project-config.ts packages/longwrite/src/lib/validation/research.ts packages/longwrite/tests/fixtures/compiled/
git commit -m "feat(longwrite): add landmark_scout stage and landmark-coverage release gate"
```

---

### Task 6: Route new findings through existing repair capabilities

**Files:**
- Modify: `packages/longwrite/src/workflow/composition.ts` (extend the `action_plan` planner's instruction at line 933–936, exact current text already verified in this plan's research)

**Interfaces:**
- Consumes: the four new `ValidationCheck` ids from Tasks 1–5 (`prose_redundancy`, `diagram_connectivity`, `claim_contradictions`, `landmark_coverage`) as they will appear in `reports/evidence-audit.md`/scorecard findings the planner already reads.
- Produces: nothing new — this task only teaches the existing planner which acceptance-criteria metric names to use for the four new finding types, so `revise_sections`, `revise_visual_plan`, `targeted_research_expansion`, and `reopen_outline` (already-existing, already-tested capabilities) can be dispatched against them.

- [ ] **Step 1: Read the current planner instructions**

```bash
cd packages/longwrite && grep -n "Allowed tools:\|Use cited_sources" src/workflow/composition.ts
```

Confirm the line number still matches (this plan verified it at line 933 during research; re-confirm before editing since earlier tasks may have shifted line numbers elsewhere in the file — `composition.ts` line numbers for this specific literal string are what matter, not absolute file position).

- [ ] **Step 2: Edit the acceptance-criteria vocabulary and routing sentence**

Find this exact string (the `Schema: {version:1,findings:...}` instruction inside the `planner` `agentStage` definition) and replace it:

Old:
```
"Schema: {version:1,findings:[{id,severity,summary}],actions:[{id,tool,finding_ids,rationale,acceptance_criteria:[{metric,target,scope?}]}]}. severity is minor, major, or critical. Every action needs at least one measurable criterion. Use cited_sources, cited_within_one_year_ratio, accepted_cited_ratio, cited_arxiv_only_ratio, citations_per_page, citation_depth_per_section (scope=A|B|C or a named section), taxonomy_cell_ab_sources (scope=taxonomy cell), comparative_tables, verified_metadata_plots, figures, tables, rendered_visual_review, empirical_trials, or review_score. Map weak comparative synthesis to a source-grounded method matrix; map taxonomy gaps to targeted recall plus woven A/B sources; map visual weakness to rendered_visual_review >= 1 plus the smallest necessary figure/table repair. Never use an empirical_trials action unless research.paper_kind is empirical and a preregistered, controlled result artifact is in scope.",
```

New:
```
"Schema: {version:1,findings:[{id,severity,summary}],actions:[{id,tool,finding_ids,rationale,acceptance_criteria:[{metric,target,scope?}]}]}. severity is minor, major, or critical. Every action needs at least one measurable criterion. Use cited_sources, cited_within_one_year_ratio, accepted_cited_ratio, cited_arxiv_only_ratio, citations_per_page, citation_depth_per_section (scope=A|B|C or a named section), taxonomy_cell_ab_sources (scope=taxonomy cell), comparative_tables, verified_metadata_plots, figures, tables, rendered_visual_review, empirical_trials, landmark_coverage_ratio, claim_contradictions, prose_redundancy, diagram_connectivity, or review_score. Map weak comparative synthesis to a source-grounded method matrix; map taxonomy gaps to targeted recall plus woven A/B sources; map visual weakness to rendered_visual_review >= 1 plus the smallest necessary figure/table repair. Map a landmark_coverage_ratio shortfall to targeted_research_expansion, naming the exact missing landmark works listed in the finding so the search is targeted rather than generic. Map a claim_contradictions finding to revise_sections with an acceptance criterion of zero remaining contradictions naming every conflicting section — or to reopen_outline instead when the conflict reflects a genuinely unresolved evidence disagreement rather than a wording slip, since reconciling it may require changing the organizing argument, not just the prose. Map a prose_redundancy finding to revise_sections. Map a diagram_connectivity finding to revise_visual_plan. Never use an empirical_trials action unless research.paper_kind is empirical and a preregistered, controlled result artifact is in scope.",
```

- [ ] **Step 3: Regenerate golden fixtures**

Run: `cd packages/longwrite && UPDATE_GOLDEN=1 npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts`
Then: `npx vitest run tests/compiled-golden.test.ts tests/generated-stage-commands.test.ts`
Expected: PASS. `git diff -- tests/fixtures/compiled/` should show only the planner instruction text changing.

- [ ] **Step 4: Run the full suite**

Run: `cd packages/longwrite && npm test && npm run build`
Expected: PASS with zero regressions across all prior tasks' tests plus this one.

- [ ] **Step 5: Commit**

```bash
git add packages/longwrite/src/workflow/composition.ts packages/longwrite/tests/fixtures/compiled/
git commit -m "feat(longwrite): route landmark/contradiction/redundancy/connectivity findings through existing repair capabilities"
```

---

## Post-plan: workspace-level config changes (not part of this code plan)

Once Tasks 1–6 are merged, the `short-rsi-survey` rerun needs a `longwrite.yaml` update (a config edit in the workspace repo, not this codebase) to actually opt into the new gates and NanoBanana, since every new gate defaults to disabled per the Global Constraints:

```yaml
research:
  corpus_gates:
    min_landmark_coverage_ratio: 0.6
  quality_control:
    max_tracked_phrase_occurrences: 15
    max_repeated_ngram_occurrences: 3
  taxonomy: []   # remove the hardcoded five-phrase list; let synthesis derive it
figures:
  quality_gates:
    require_insight_statements: true
  backends:
    nanobanana:
      enabled: true
```

This is a deliberately separate, reversible step from the code plan above — do not fold it into any Task's commit.
