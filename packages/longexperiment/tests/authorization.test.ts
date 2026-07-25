import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as toYaml } from "yaml";
import { ExperimentConfig, ExperimentPilot } from "../src/lib/schema.js";
import {
  AUTHORIZATION_PATH,
  assertAuthorizedForUnattendedRun,
  hashExperimentConfig,
  issueLease,
  readLease,
  validateLease,
} from "../src/lib/authorization.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    project: { id: "memory-ablation" },
    profile: "existing_code",
    hypothesis: "Memory helps planning.",
    inputs: { code: [{ id: "repo", source: "https://example.com/repo.git", revision: "abcdef1234567", materialize: "external" }] },
    evaluation: {
      primary_metric: "success_rate", direction: "maximize", baseline_id: "baseline",
      control: "fixed prompts", seeds: [11, 23], statistical_test: "paired bootstrap",
    },
    suite: {
      id: "suite", max_rounds: 2,
      studies: [{ id: "baseline", kind: "inference_comparison", conditions: ["baseline"], acceptance_criteria: ["baseline"] }],
    },
    runner: { kind: "command", command: "true" },
    execution: {
      max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
      requires_design_approval: false, requires_revision_approval: false,
    },
    ...overrides,
  };
}

async function workspace(config: Record<string, unknown> = rawConfig()): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "le-auth-"));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, "experiment.yaml"), toYaml(config), "utf-8");
  return dir;
}

const GRANT = {
  maxTrials: 30, maxGpuHours: 8, maxWallHours: 12, expiresInHours: 24, approvedBy: "operator@example.com",
};

describe("pilot discriminant (LE-1.1)", () => {
  it("exposes exactly the three pilots", () => {
    expect(ExperimentPilot.options).toEqual([
      "repository_optimization", "survey_pilot_study", "paper_reproduction",
    ]);
  });

  it("is optional so legacy configs keep parsing, and is never inferred", () => {
    // No silent conversion: an old workspace stays pilot-less until a human
    // declares one, because inferring it would change how it executes.
    const parsed = ExperimentConfig.parse(rawConfig());
    expect(parsed.pilot).toBeUndefined();
  });

  it("accepts an explicit pilot and rejects an unknown one", () => {
    expect(ExperimentConfig.parse(rawConfig({ pilot: "repository_optimization" })).pilot)
      .toBe("repository_optimization");
    expect(() => ExperimentConfig.parse(rawConfig({ pilot: "not_a_pilot" }))).toThrow();
  });
});

describe("execution authorization (LE-1.2)", () => {
  it("defaults to no authorization block, meaning interactive", () => {
    expect(ExperimentConfig.parse(rawConfig()).execution.authorization).toBeUndefined();
  });

  it("rejects interactive authorization with the approval gates switched off", () => {
    // Declaring "interactive" while the gates are off reads as supervised but
    // behaves as unattended.
    expect(() => ExperimentConfig.parse(rawConfig({
      execution: {
        max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
        requires_design_approval: false, requires_revision_approval: false,
        authorization: { mode: "interactive" },
      },
    }))).toThrow(/interactive authorization requires design and revision approval gates/);
  });

  it("refuses unattended execution on a local command runner", () => {
    // Agent-authored code must not run on the control-plane host.
    expect(() => ExperimentConfig.parse(rawConfig({
      execution: {
        max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
        requires_design_approval: true, requires_revision_approval: true,
        authorization: { mode: "unattended", lease_path: AUTHORIZATION_PATH, isolation: "ephemeral_container" },
      },
    }))).toThrow(/requires an isolated runner/);
  });
});

describe("config hashing", () => {
  it("ignores formatting and key order", async () => {
    const a = ExperimentConfig.parse(rawConfig());
    const reordered = rawConfig();
    const rebuilt = Object.fromEntries(Object.entries(reordered).reverse());
    const b = ExperimentConfig.parse(rebuilt);
    expect(hashExperimentConfig(a)).toBe(hashExperimentConfig(b));
  });

  it("changes when something the engine would act on changes", () => {
    const base = ExperimentConfig.parse(rawConfig());
    const more = ExperimentConfig.parse(rawConfig({
      execution: {
        max_trials: 99, max_active_run_minutes: 10, max_parallel_trials: 2,
        requires_design_approval: false, requires_revision_approval: false,
      },
    }));
    expect(hashExperimentConfig(more)).not.toBe(hashExperimentConfig(base));
  });
});

describe("issuing and validating a lease", () => {
  it("writes a lease bound to the config and appends to history", async () => {
    const ws = await workspace();
    const lease = await issueLease(ws, GRANT);

    expect(lease).toMatchObject({
      version: 1, max_trials: 30, max_gpu_hours: 8, network_policy: "allowlist",
      approved_by: "operator@example.com",
    });
    expect(lease.allowed_hosts).toContain("huggingface.co");
    expect(await readLease(ws)).toEqual(lease);

    const history = await fs.readFile(path.join(ws, ".longexperiment", "authorization-history.jsonl"), "utf-8");
    expect(history.trim().split("\n")).toHaveLength(1);
  });

  it("validates a fresh lease", async () => {
    const ws = await workspace();
    await issueLease(ws, GRANT);
    expect(await validateLease(ws)).toMatchObject({ valid: true });
  });

  it("invalidates the lease when experiment.yaml changes", async () => {
    // The whole point of binding: a lease granted for a small ablation must not
    // silently authorize whatever the config becomes afterwards.
    const ws = await workspace();
    await issueLease(ws, GRANT);
    await fs.writeFile(
      path.join(ws, "experiment.yaml"),
      toYaml(rawConfig({ hypothesis: "Something else entirely." })),
      "utf-8",
    );

    const result = await validateLease(ws);
    expect(result.valid).toBe(false);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/experiment\.yaml changed/);
  });

  it("survives a pure reformat of experiment.yaml", async () => {
    const ws = await workspace();
    await issueLease(ws, GRANT);
    const reparsed = ExperimentConfig.parse(rawConfig());
    await fs.writeFile(path.join(ws, "experiment.yaml"), toYaml(reparsed) + "\n# a comment\n", "utf-8");
    expect(await validateLease(ws)).toMatchObject({ valid: true });
  });

  it("rejects an expired lease", async () => {
    const ws = await workspace();
    await issueLease(ws, { ...GRANT, expiresInHours: 1 });
    const later = new Date(Date.now() + 2 * 3_600_000);
    const result = await validateLease(ws, later);
    expect(result.valid).toBe(false);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/expired/);
  });

  it("rejects a lease issued in the future", async () => {
    const ws = await workspace();
    await issueLease(ws, GRANT);
    const earlier = new Date(Date.now() - 3_600_000);
    const result = await validateLease(ws, earlier);
    expect(result.valid).toBe(false);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/issued in the future/);
  });

  it("rejects a lease that caps fewer trials than the config will run", async () => {
    const ws = await workspace(rawConfig({
      execution: {
        max_trials: 500, max_active_run_minutes: 10, max_parallel_trials: 2,
        requires_design_approval: false, requires_revision_approval: false,
      },
    }));
    await issueLease(ws, GRANT);
    const result = await validateLease(ws);
    expect(result.valid).toBe(false);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/caps them at 30/);
  });

  it("rejects an allowlist policy with no hosts", async () => {
    const ws = await workspace();
    await issueLease(ws, { ...GRANT, allowedHosts: [] });
    const result = await validateLease(ws);
    expect(result.valid).toBe(false);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/allowed_hosts is empty/);
  });

  it("treats a missing lease as unauthorized, not as permission", async () => {
    const ws = await workspace();
    const result = await validateLease(ws);
    expect(result.valid).toBe(false);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/no authorization lease/);
  });
});

describe("gating an unattended run", () => {
  const unattended = () => rawConfig({
    runner: { kind: "modal", app_path: "adapters/modal/adapter.py", function_ref: "run_trial", gpu: "A10G", max_gpu_hours: 4, adapter_command: "python3 adapters/modal/adapter.py" },
    execution: {
      max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
      requires_design_approval: true, requires_revision_approval: true,
      authorization: { mode: "unattended", lease_path: AUTHORIZATION_PATH, isolation: "ephemeral_container" },
    },
  });

  it("allows an interactive workspace with no lease", async () => {
    const ws = await workspace();
    await expect(assertAuthorizedForUnattendedRun(ws)).resolves.toBeNull();
  });

  it("blocks an unattended workspace without a lease", async () => {
    const ws = await workspace(unattended());
    await expect(assertAuthorizedForUnattendedRun(ws))
      .rejects.toThrow(/Unattended execution is not authorized[\s\S]*no authorization lease/);
  });

  it("allows an unattended workspace with a valid lease", async () => {
    const ws = await workspace(unattended());
    await issueLease(ws, GRANT);
    await expect(assertAuthorizedForUnattendedRun(ws)).resolves.toMatchObject({ max_trials: 30 });
  });

  it("refuses a lease_path pointing somewhere unmanaged", async () => {
    // Otherwise a config could aim authorization at a file nobody validates.
    const ws = await workspace(rawConfig({
      runner: { kind: "modal", app_path: "a.py", function_ref: "f", gpu: "A10G", max_gpu_hours: 4, adapter_command: "python3 a.py" },
      execution: {
        max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2,
        requires_design_approval: true, requires_revision_approval: true,
        authorization: { mode: "unattended", lease_path: "my-own-lease.json", isolation: "ephemeral_vm" },
      },
    }));
    await issueLease(ws, GRANT);
    await expect(assertAuthorizedForUnattendedRun(ws)).rejects.toThrow(/only read from the managed path/);
  });
});
