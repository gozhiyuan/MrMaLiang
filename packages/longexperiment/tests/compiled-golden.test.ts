import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { parse as parseYaml } from "yaml";
import { compileExperimentToManifest } from "../src/lib/compiler.js";
import { ExperimentConfig } from "../src/lib/schema.js";
import { FLAGSHIP_IDS } from "../src/lib/flagships.js";

/**
 * Phase MM-0.1 / LE-0.1: frozen golden manifests for LongExperiment.
 *
 * These pin what the experiment compiler emits today. LE-3.3 moves agentic
 * full trials onto `remote-job`, and MM-2.2 splits this compiler — both are
 * required to preserve dependency levels, the per-study foreach execute/audit
 * shape, the design and candidate approval gates, and the deterministic
 * aggregate/publication-eligibility stages. A diff here must be deliberate.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const fixturesDir = path.join(here, "fixtures", "compiled");
const flagshipsDir = path.join(packageRoot, "configs", "flagships");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

/** Strip machine-specific values so fixtures are portable across machines. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = normalize(item);
    return out;
  }
  if (typeof value !== "string") return value;
  if (value === process.execPath) return "<node>";
  return value
    .replace(/^.*[/\\]packages[/\\]longexperiment[/\\]dist[/\\]cli\.js$/, "<longexperiment-cli>")
    .replace(/^.*[/\\]packages[/\\]longwrite[/\\]dist[/\\]cli\.js$/, "<longwrite-cli>");
}

function baseConfig(overrides: Record<string, unknown> = {}): ExperimentConfig {
  return ExperimentConfig.parse({
    version: 1,
    project: { id: "memory-ablation" },
    profile: "existing_code",
    hypothesis: "Memory helps planning.",
    inputs: {
      code: [{ id: "repo", source: "https://example.com/repo.git", revision: "abcdef1234567", materialize: "external" }],
    },
    evaluation: {
      primary_metric: "success_rate",
      direction: "maximize",
      baseline_id: "baseline",
      control: "fixed prompts",
      seeds: [11, 23],
      statistical_test: "paired bootstrap confidence interval",
    },
    suite: {
      id: "suite",
      max_rounds: 2,
      studies: [
        { id: "baseline", kind: "inference_comparison", conditions: ["baseline"], acceptance_criteria: ["baseline"] },
        {
          id: "candidate", kind: "training_ablation", depends_on: ["baseline"],
          conditions: ["candidate"], acceptance_criteria: ["candidate"],
        },
      ],
    },
    runner: { kind: "command", command: "true" },
    execution: {
      max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
      requires_design_approval: false, requires_revision_approval: false,
    },
    ...overrides,
  });
}

type Scenario = { file: string; description: string; build(): ExperimentConfig };

const SCENARIOS: Scenario[] = [
  {
    file: "prescribed-command.json",
    description: "Prescribed experiment with a local command runner",
    build: () => baseConfig(),
  },
  {
    file: "agentic-candidate.json",
    description: "Agentic experiment with design and revision approvals",
    build: () => baseConfig({
      // existing_code agentic authoring must name the pinned input the agent
      // may modify — the schema refuses an unbounded mutable surface.
      authoring: { mode: "agentic", base_input_id: "repo" },
      execution: {
        max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
        requires_design_approval: true, requires_revision_approval: true,
      },
    }),
  },
  {
    file: "modal-runner.json",
    description: "Modal runner routed through a workspace-owned adapter",
    build: () => baseConfig({
      runner: {
        kind: "modal",
        app_path: "adapters/modal/adapter.py",
        function_ref: "run_trial",
        gpu: "A10G",
        max_gpu_hours: 4,
        adapter_command: "python3 adapters/modal/adapter.py",
      },
    }),
  },
];

describe("LongExperiment compiled manifest goldens", () => {
  for (const scenario of SCENARIOS) {
    it(`matches the frozen manifest: ${scenario.description}`, async () => {
      const actual = normalize(compileExperimentToManifest(scenario.build()));
      const target = path.join(fixturesDir, scenario.file);

      if (UPDATE) {
        await fs.mkdir(fixturesDir, { recursive: true });
        await fs.writeFile(target, `${JSON.stringify(actual, null, 2)}\n`, "utf-8");
      }

      const expected = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(actual, `${scenario.file} drifted; re-run with UPDATE_GOLDEN=1 if intentional`).toEqual(expected);
    });
  }

  for (const flagship of FLAGSHIP_IDS) {
    it(`matches the frozen manifest for flagship ${flagship}`, async () => {
      const raw = await fs.readFile(path.join(flagshipsDir, `${flagship}.yaml`), "utf-8");
      const actual = normalize(compileExperimentToManifest(ExperimentConfig.parse(parseYaml(raw))));
      const target = path.join(fixturesDir, `flagship-${flagship}.json`);

      if (UPDATE) {
        await fs.mkdir(fixturesDir, { recursive: true });
        await fs.writeFile(target, `${JSON.stringify(actual, null, 2)}\n`, "utf-8");
      }

      const expected = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(actual, `flagship ${flagship} drifted`).toEqual(expected);
    });
  }
});

/**
 * Structural invariants the goldens must keep expressing. Without these, a
 * refactor could emit a hollowed-out manifest that still matched a stale
 * fixture.
 */
describe("golden experiment manifests keep their scientific structure", () => {
  const stagesOf = (config: ExperimentConfig) =>
    (compileExperimentToManifest(config).workflow as { stages: Array<Record<string, unknown>> }).stages;

  it("orders pin -> plan -> per-study execute/audit -> aggregate -> audit -> report", () => {
    const ids = stagesOf(baseConfig()).map((s) => String(s.id));
    const index = (needle: string) => ids.findIndex((id) => id.includes(needle));
    expect(index("pin")).toBeGreaterThanOrEqual(0);
    expect(index("pin")).toBeLessThan(index("plan"));
    expect(index("aggregate")).toBeLessThan(index("audit"));
    expect(index("audit")).toBeLessThan(index("report"));
  });

  it("runs each study as a foreach with execute and audit steps", () => {
    const foreachStages = stagesOf(baseConfig()).filter((s) => s.type === "foreach");
    expect(foreachStages.length).toBeGreaterThan(0);
    const steps = foreachStages.flatMap((s) => (s.steps as Array<{ id: string }>).map((step) => step.id));
    // Audit is a separate deterministic step: a runner never certifies itself.
    expect(steps).toContain("execute");
    expect(steps).toContain("audit");
  });

  it("compiles study dependencies into ordered execution levels", () => {
    // Study ids are resolved at RUNTIME from the suite-plan artifact, so they
    // never appear as stage ids. Dependencies are expressed as levels instead:
    // `candidate` depends_on `baseline`, so the two cannot share a level.
    const levels = stagesOf(baseConfig())
      .filter((s) => s.type === "foreach")
      .map((s) => ({ id: String(s.id), over: String(s.foreach) }));

    expect(levels.map((l) => l.id)).toEqual(["study_level_1", "study_level_2"]);
    expect(levels.map((l) => l.over)).toEqual(["runs/study-level-1.items", "runs/study-level-2.items"]);

    // An independent suite collapses to a single level.
    const independent = baseConfig({
      suite: {
        id: "suite", max_rounds: 2, studies: [
          { id: "a", kind: "inference_comparison", conditions: ["baseline"], acceptance_criteria: ["a"] },
          { id: "b", kind: "inference_comparison", conditions: ["baseline"], acceptance_criteria: ["b"] },
        ],
      },
    });
    expect(stagesOf(independent).filter((s) => s.type === "foreach").map((s) => s.id))
      .toEqual(["study_level_1"]);
  });

  it("keeps design and candidate approval gates in agentic mode", () => {
    const agentic = JSON.stringify(compileExperimentToManifest(SCENARIOS[1].build()));
    expect(agentic).toMatch(/"requires_human_approval":true/);
    // The prescribed variant with approvals disabled must not carry them.
    const prescribed = JSON.stringify(compileExperimentToManifest(baseConfig()));
    expect(prescribed).not.toBe(agentic);
  });

  it("routes the Modal runner through the declared adapter command", () => {
    const flat = JSON.stringify(compileExperimentToManifest(SCENARIOS[2].build()));
    expect(flat).toContain("adapters/modal/adapter.py");
    // Credentials must never be serialized into the manifest.
    expect(flat).not.toMatch(/MODAL_TOKEN|api[_-]?key|secret/i);
  });

  it("normalizes machine-specific paths out of the fixtures", () => {
    const flat = JSON.stringify(normalize(compileExperimentToManifest(baseConfig())));
    expect(flat).not.toContain(process.execPath);
    expect(flat).not.toMatch(/"\/(Users|home)\//);
  });
});
