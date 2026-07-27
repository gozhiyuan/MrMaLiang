import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { compileModeToManifest, type CompileOptions, type CompileResearchPolicy } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";
import { RESEARCH_WORKFLOW_PROFILE_DEFS } from "../src/lib/research/workflow-profiles.js";

/**
 * Phase MM-0.1: frozen golden manifests.
 *
 * These pin what the LongWrite compiler emits TODAY, before any extraction or
 * SDK adoption. MM-1 (module extraction) and MM-2 (compiler split) are required
 * to preserve output exactly; MM-4.4 forbids migration unless the old and new
 * compilers emit structurally identical IR for these fixtures.
 *
 * A diff here is not automatically a bug — but it must be a deliberate,
 * reviewed fixture update, never a silent change.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "compiled");
/** Set UPDATE_GOLDEN=1 to rewrite fixtures after an intentional change. */
const UPDATE = process.env.UPDATE_GOLDEN === "1";

/**
 * Replace machine-specific values so the fixtures are portable.
 *
 * `longwriteCommand()` embeds `process.execPath` and an absolute package path;
 * committing those would make the goldens fail on every other machine and in
 * CI, hiding the real signal.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalize(item);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  let text = value;
  if (text === process.execPath) return "<node>";
  // Absolute path into the built LongWrite CLI.
  text = text.replace(/^.*[/\\]packages[/\\]longwrite[/\\]dist[/\\]cli\.js$/, "<longwrite-cli>");
  text = text.replace(/^.*[/\\]packages[/\\]longexperiment[/\\]dist[/\\]cli\.js$/, "<longexperiment-cli>");
  return text;
}

function policy(overrides: Partial<CompileResearchPolicy> = {}): CompileResearchPolicy {
  return {
    targetCandidates: 240,
    queryBudget: 30,
    taxonomy: ["memory", "planning", "evaluation"],
    fulltextMaxSources: 40,
    allowPdfDownload: false,
    verificationMaxSources: 40,
    writingStrategy: "scaffold_then_revise",
    ...overrides,
  };
}

function fromProfile(id: "fast" | "standard" | "deep", overrides: Partial<CompileResearchPolicy> = {}): CompileResearchPolicy {
  const def = RESEARCH_WORKFLOW_PROFILE_DEFS[id];
  return policy({
    workflowProfile: id,
    targetCandidates: def.targetCandidates,
    queryBudget: def.queryBudget,
    fulltextMaxSources: def.fulltextMaxSources,
    verificationMaxSources: def.fulltextMaxSources,
    ...overrides,
  });
}

type Scenario = {
  file: string;
  description: string;
  mode: string;
  options: CompileOptions;
};

const SCENARIOS: Scenario[] = [
  {
    file: "fast-literature-survey.json",
    description: "Fast literature survey — bounded exploratory pass",
    mode: "auto_research_agentic",
    options: {
      projectId: "fast-survey",
      projectName: "Fast Survey",
      topic: "Long-horizon agent memory",
      researchProvider: "seed",
      researchPolicy: fromProfile("fast", { paperProfile: "literature_survey" }),
    },
  },
  {
    file: "standard-repository-study.json",
    description: "Standard repository study — pinned codebase evidence",
    mode: "auto_research_agentic",
    options: {
      projectId: "repo-study",
      projectName: "Repository Study",
      topic: "Agent orchestration frameworks",
      researchProvider: "seed",
      researchPolicy: fromProfile("standard", {
        paperProfile: "repository_study",
        codebases: [
          { id: "crewai", source: "https://github.com/crewAIInc/crewAI", ref: "b3aaaab", role: "primary_artifact" },
          { id: "autogen", source: "https://github.com/microsoft/autogen", ref: "HEAD", role: "supplementary_artifact" },
        ],
      }),
    },
  },
  {
    file: "deep-flagship-survey.json",
    description: "Deep flagship survey — full breadth, all optional stages",
    mode: "auto_research_agentic",
    options: {
      projectId: "deep-survey",
      projectName: "Deep Survey",
      topic: "Long-horizon agent memory",
      researchProvider: "seed",
      researchPolicy: fromProfile("deep", {
        paperProfile: "literature_survey",
        semanticScreenEnabled: true,
        outlineReviewEnabled: true,
        outlineReviewMaxRounds: 3,
        outlineApprovalMode: "human",
      }),
    },
  },
  {
    // The corpus-gate recovery loop only compiles when semantic screening is
    // enabled AND the provider is live. With the seed provider it is skipped
    // entirely, so without this scenario the goldens would not cover
    // corpus_gate_pass at all.
    file: "deep-live-provider-semantic-screen.json",
    description: "Deep survey on a live provider — semantic screen and corpus recovery loop",
    mode: "auto_research_agentic",
    options: {
      projectId: "deep-live",
      projectName: "Deep Live Survey",
      topic: "Long-horizon agent memory",
      researchProvider: "openalex",
      researchPolicy: fromProfile("deep", {
        paperProfile: "literature_survey",
        semanticScreenEnabled: true,
        outlineReviewEnabled: true,
        outlineReviewMaxRounds: 3,
        outlineApprovalMode: "human",
      }),
    },
  },
  {
    file: "empirical-before-handoff.json",
    description: "Empirical writing BEFORE the experiment manifest exists",
    mode: "auto_research_agentic",
    options: {
      projectId: "empirical-pre",
      projectName: "Empirical Paper",
      topic: "Hierarchical decomposition and action horizon",
      researchProvider: "seed",
      researchPolicy: fromProfile("standard", {
        paperProfile: "literature_survey",
        experiment: { enabled: true },
      }),
    },
  },
  {
    file: "empirical-after-handoff.json",
    description: "Empirical writing AFTER the experiment manifest is imported",
    mode: "auto_research_agentic",
    options: {
      projectId: "empirical-post",
      projectName: "Empirical Paper",
      topic: "Hierarchical decomposition and action horizon",
      researchProvider: "seed",
      researchPolicy: fromProfile("standard", {
        paperProfile: "literature_survey",
        experiment: {
          enabled: true,
          manifestPath: "../experiment/results/experiment-manifest.json",
          codebaseId: "primary",
          inputId: "primary",
        },
      }),
    },
  },
];

/** Look scenarios up by name so assertions do not break when the list grows. */
function byFile(file: string): Scenario {
  const scenario = SCENARIOS.find((s) => s.file === file);
  if (!scenario) throw new Error(`no scenario named ${file}`);
  return scenario;
}

async function compiled(scenario: Scenario): Promise<unknown> {
  const mode = await loadMode(scenario.mode);
  return normalize(compileModeToManifest(mode, scenario.options));
}

describe("LongWrite compiled manifest goldens", () => {
  for (const scenario of SCENARIOS) {
    it(`matches the frozen manifest: ${scenario.description}`, async () => {
      const actual = await compiled(scenario);
      const target = path.join(fixturesDir, scenario.file);

      if (UPDATE) {
        await fs.mkdir(fixturesDir, { recursive: true });
        await fs.writeFile(target, `${JSON.stringify(actual, null, 2)}\n`, "utf-8");
      }

      const expected = JSON.parse(await fs.readFile(target, "utf-8"));
      expect(actual, `${scenario.file} drifted; re-run with UPDATE_GOLDEN=1 if intentional`).toEqual(expected);
    });
  }

  it("captures every scenario the plan requires", () => {
    expect(SCENARIOS.map((s) => s.file).sort()).toEqual([
      "deep-flagship-survey.json",
      "deep-live-provider-semantic-screen.json",
      "empirical-after-handoff.json",
      "empirical-before-handoff.json",
      "fast-literature-survey.json",
      "standard-repository-study.json",
    ]);
  });
});

/**
 * MM-0.1 requires the goldens to carry specific structure. These assertions
 * make that explicit: if a future refactor emitted a manifest that merely
 * happened to match a stale fixture, these would still catch a hollowed-out
 * workflow.
 */
describe("golden manifests carry the required structure", () => {
  it("records stage ids, runtimes, validators, approvals and run limits", async () => {
    const manifest = await compiled(byFile("standard-repository-study.json")) as {
      workflow: {
        stages: Array<Record<string, unknown>>;
        tool_catalog?: unknown[];
        run_limits?: unknown;
      };
    };
    const stages = manifest.workflow.stages;

    expect(stages.length).toBeGreaterThan(5);
    expect(stages.every((s) => typeof s.id === "string")).toBe(true);

    const flat = JSON.stringify(manifest);
    expect(flat).toMatch(/"runtime":"script"/);
    expect(flat).toMatch(/"validator_commands"/);
    expect(flat).toMatch(/"requires_human_approval":true/);
  });

  it("keeps the fast profile strictly smaller than deep", async () => {
    const count = async (scenario: Scenario) => {
      const m = await compiled(scenario) as { workflow: { stages: Array<{ enabled?: boolean }> } };
      return m.workflow.stages.filter((s) => s.enabled !== false).length;
    };
    // fast disables snowball_recall, venue_upgrade and structure_audit.
    expect(await count(byFile("fast-literature-survey.json"))).toBeLessThan(await count(byFile("deep-flagship-survey.json")));
  });

  it("adds experiment evidence stages only once a manifest path exists", async () => {
    const before = JSON.stringify(await compiled(byFile("empirical-before-handoff.json")));
    const after = JSON.stringify(await compiled(byFile("empirical-after-handoff.json")));
    expect(after).toContain("experiment-manifest.json");
    expect(before).not.toContain("../experiment/results/experiment-manifest.json");
  });

  it("normalizes machine-specific paths out of the fixtures", async () => {
    const flat = JSON.stringify(await compiled(byFile("fast-literature-survey.json")));
    expect(flat).toContain("<node>");
    expect(flat).not.toContain(process.execPath);
    // No absolute filesystem paths may leak into a committed golden.
    expect(flat).not.toMatch(/"\/(Users|home|tmp)\//);
  });
});
