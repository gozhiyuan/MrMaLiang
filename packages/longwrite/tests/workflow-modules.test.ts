import { describe, expect, it } from "vitest";
import { Manifest } from "malaclaw/dist/lib/schema.js";
import { defineWorkflow, useModule } from "malaclaw/sdk";
import { citationAuditModule, controlledExperimentSuiteModule, LONGWRITE_WORKFLOW_MODULES, reviewReviseBuildModule, reviewedOutlineModule } from "../src/modules/workflow-modules.js";

const cli = { cmd: "node", args: ["dist/cli.js"] };

describe("LongWrite workflow modules (MM-4.2)", () => {
  it("every module expands into stages the engine schema accepts", () => {
    const stages = LONGWRITE_WORKFLOW_MODULES.flatMap((module) =>
      useModule(module, { config: { cli } as never }));

    const manifest = defineWorkflow({ id: "module-smoke", stages }).manifest();
    // The engine must not be able to tell a module-produced stage from a
    // hand-written one: it parses as an ordinary manifest or not at all.
    expect(() => Manifest.parse(manifest)).not.toThrow();
    expect(stages.length).toBeGreaterThan(LONGWRITE_WORKFLOW_MODULES.length);
  });

  it("namespaces stage ids so one module can be used twice without collision", () => {
    const first = useModule(citationAuditModule, { as: "primary", config: { cli } as never });
    const second = useModule(citationAuditModule, { as: "recovery", config: { cli } as never });

    const ids = [...first, ...second].map((stage) => (stage as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("primary_audit");
    expect(ids).toContain("recovery_audit");
  });

  it("keeps the quality loop bounded and the stop condition explicit", () => {
    const [loop] = useModule(reviewReviseBuildModule, { config: { cli, maxRounds: 4, targetScore: 9 } as never }) as Array<Record<string, unknown>>;
    expect(loop).toMatchObject({ type: "loop", max_rounds: 4, stop_when: "review_score >= 9", on_exhaustion: "fail" });
  });

  it("makes the human outline gate optional but durable when enabled", () => {
    const withGate = useModule(reviewedOutlineModule, { config: { cli } as never }) as Array<Record<string, unknown>>;
    const withoutGate = useModule(reviewedOutlineModule, { config: { cli, requiresHumanApproval: false } as never }) as Array<Record<string, unknown>>;

    expect(withGate.some((stage) => stage.requires_human_approval === true)).toBe(true);
    expect(withoutGate.some((stage) => stage.requires_human_approval === true)).toBe(false);
  });

  it("fans studies out through a real foreach with a parallelism ceiling", () => {
    const stages = useModule(controlledExperimentSuiteModule, { config: { cli, maxParallel: 3 } as never }) as Array<Record<string, unknown>>;
    const fanout = stages.find((stage) => stage.type === "foreach")!;
    expect(fanout).toMatchObject({ item_name: "study", max_parallel: 3 });
    expect((fanout.steps as Array<{ id: string }>).map((step) => step.id)).toEqual(["run", "audit"]);
  });

  it("declares a config schema and semver for every module", () => {
    for (const module of LONGWRITE_WORKFLOW_MODULES) {
      expect(module.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(module.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(module.config).toBeTruthy();
    }
  });
});
