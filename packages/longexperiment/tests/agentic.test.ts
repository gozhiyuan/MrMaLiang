import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeAgentCandidateStage, testAgentCandidateStage } from "../src/lib/agentic.js";
import { ExperimentConfig } from "../src/lib/schema.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.MALIANG_TEST_SECRET;
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-agentic-stage-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "agent"), { recursive: true });
  await fs.mkdir(path.join(root, "reports"), { recursive: true });
  return root;
}

function config(baseInputId?: string) {
  return ExperimentConfig.parse({
    version: 1,
    project: { id: "agentic-test" },
    profile: baseInputId ? "existing_code" : "from_scratch",
    authoring: { mode: "agentic", ...(baseInputId ? { base_input_id: baseInputId } : {}) },
    hypothesis: "A bounded candidate can be tested reproducibly.",
    inputs: { code: baseInputId ? [{ id: baseInputId, source: "https://example.invalid/base.git", revision: "abcdef1234567" }] : [] },
    evaluation: { primary_metric: "score", direction: "maximize", baseline_id: "baseline", control: "fixed test control", seeds: [1, 2], statistical_test: "paired bootstrap" },
    suite: { id: "test-suite", studies: [{ id: "primary", kind: "training_ablation", acceptance_criteria: ["complete every pair"], conditions: ["baseline", "candidate"] }] },
  });
}

function bundle(extra: Array<{ path: string; role: "source" | "test"; content: string }> = []) {
  return {
    version: 1,
    entrypoint: "maliang_runner.py",
    summary: "A complete bounded candidate overlay for the current revision.",
    files: [
      { path: "maliang_runner.py", role: "source", content: "print('{\\\"metric\\\": 1}')\n" },
      { path: "test_candidate.py", role: "test", content: "import unittest\nclass T(unittest.TestCase):\n    pass\n" },
      ...extra,
    ],
  };
}

describe("agentic candidate materialization", () => {
  it("reconstructs every revision so omitted overlay files cannot survive", async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, "agent", "candidate-bundle.json"), JSON.stringify(bundle([{ path: "old.py", role: "source", content: "OLD = True\n" }])), "utf8");
    await materializeAgentCandidateStage(root, config());
    await fs.access(path.join(root, "agent", "candidate", "project", "old.py"));

    await fs.writeFile(path.join(root, "agent", "candidate-bundle.json"), JSON.stringify(bundle()), "utf8");
    await materializeAgentCandidateStage(root, config());
    await expect(fs.access(path.join(root, "agent", "candidate", "project", "old.py"))).rejects.toThrow();
  });

  it("rejects an overlay that would follow a symlink from the pinned base", async () => {
    const root = await workspace();
    const base = path.join(root, "inputs", "base", "repo");
    await fs.mkdir(base, { recursive: true });
    const outside = path.join(root, "outside.py");
    await fs.writeFile(outside, "SAFE = True\n", "utf8");
    await fs.symlink(outside, path.join(base, "linked.py"));
    await fs.writeFile(path.join(root, "inputs", "locks.json"), JSON.stringify({ version: 1, inputs: [{ id: "base", revision: "abcdef1234567", resolved_revision: "abcdef1234567", materialized_path: "inputs/base/repo" }] }), "utf8");
    await fs.writeFile(path.join(root, "agent", "candidate-bundle.json"), JSON.stringify(bundle([{ path: "linked.py", role: "source", content: "OVERWRITE = True\n" }])), "utf8");

    await expect(materializeAgentCandidateStage(root, config("base"))).rejects.toThrow(/symbolic link/);
    expect(await fs.readFile(outside, "utf8")).toBe("SAFE = True\n");
  });

  it("does not inherit unrelated operator credentials into generated tests", async () => {
    const root = await workspace();
    process.env.MALIANG_TEST_SECRET = "must-not-leak";
    const candidate = bundle();
    candidate.files[1].content = [
      "import os", "import unittest", "class T(unittest.TestCase):",
      "    def test_environment(self):", "        self.assertIsNone(os.getenv('MALIANG_TEST_SECRET'))",
      "        self.assertTrue(os.getenv('HOME', '').endswith('agent/runtime-home'))", "",
    ].join("\n");
    await fs.writeFile(path.join(root, "agent", "candidate-bundle.json"), JSON.stringify(candidate), "utf8");
    const parsed = config();
    await materializeAgentCandidateStage(root, parsed);
    await testAgentCandidateStage(root, parsed);
    const result = JSON.parse(await fs.readFile(path.join(root, "agent", "candidate-test.json"), "utf8"));
    expect(result.pass).toBe(true);
  });
});
