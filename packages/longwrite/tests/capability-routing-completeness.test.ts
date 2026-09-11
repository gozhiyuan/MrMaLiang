import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/lib/registry/producers.js";
import { CAPABILITY_TEMPLATES, toolCeilingFor } from "../src/lib/registry/capabilities.js";
import { capabilitiesOfPhase, phaseOf, phaseRoutes } from "../src/lib/registry/phases.js";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";

/** Every capability a finding can be routed to must be executable.
 *
 * Routing, templating, plan-splitting and the catalog are four separate lists,
 * and a capability present in the first three and absent from the fourth is
 * invisible: the planner may select it, validation accepts it, the splitter
 * drops it into no phase, and the dispatcher has nothing to run. The recovery
 * loop then diagnoses the same objective every round with nothing ever acting
 * on it — a failure that produces no error anywhere. */

type Stage = {
  id: string; type?: string; allowed_actions?: string[]; plan_path?: string;
  max_actions?: number; outputs?: string[]; stages?: Stage[]; steps?: Stage[];
};

function flatten(stages: Stage[]): Stage[] {
  return stages.flatMap((stage) =>
    [stage, ...flatten(stage.stages ?? []), ...flatten(stage.steps ?? [])]);
}

async function compiled(): Promise<{ stages: Stage[]; catalog: Array<{ id: string; runtime?: string; allowed_tools?: string[] }> }> {
  const mode = await loadMode("auto_research_agentic");
  const manifest = await compileModeToManifest(mode, {
    projectId: "routing-fixture", artifactType: "research_paper",
    topic: "routing", researchProvider: "seed",
  } as never) as { workflow: { stages: Stage[]; tool_catalog: Array<{ id: string; runtime?: string; allowed_tools?: string[] }> } };
  return { stages: flatten(manifest.workflow.stages), catalog: manifest.workflow.tool_catalog };
}

describe("every routable capability is executable", () => {
  it("has a template, a catalog action, and a dispatch that allows it", async () => {
    const { stages, catalog } = await compiled();
    const dispatchable = new Set(stages
      .filter((stage) => stage.type === "action_dispatch")
      .flatMap((stage) => stage.allowed_actions ?? []));
    const catalogued = new Set(catalog.map((action) => action.id));

    for (const capability of [...REGISTRY.capabilities()].map(String)) {
      expect(CAPABILITY_TEMPLATES.has(capability), `${capability} has no template`).toBe(true);
      expect(catalogued.has(capability), `${capability} has no catalog action to dispatch`).toBe(true);
      expect(dispatchable.has(capability), `${capability} is allowed by no dispatch stage`).toBe(true);
    }
  });

  it("belongs to exactly one phase, whose dispatcher reads that phase's plan", async () => {
    const { stages } = await compiled();
    // The previous check proved SOME dispatcher permitted a capability. It did
    // not prove that the dispatcher permitting it is the one reading the file
    // the splitter writes it into — so a capability could be allowed by a
    // dispatcher that never sees its plan, and dropped by the one that does.
    for (const capability of [...REGISTRY.capabilities()].map(String)) {
      const route = phaseOf(capability);
      const phases = phaseRoutes().filter((candidate) =>
        capabilitiesOfPhase(candidate.phase).includes(capability));
      expect(phases.map((p) => p.phase), `${capability} is in more than one phase`).toEqual([route.phase]);

      const dispatchers = stages.filter((stage) =>
        stage.type === "action_dispatch" && (stage.allowed_actions ?? []).includes(capability));
      expect(dispatchers.length, `${capability} is allowed by no dispatcher`).toBeGreaterThan(0);
      for (const dispatcher of dispatchers) {
        // The one that permits it must be the one reading the plan the
        // splitter writes it to.
        expect(dispatcher.plan_path, `${dispatcher.id} permits ${capability} but reads another phase's plan`)
          .toBe(route.planPath);
      }
    }
  });

  it("gives each dispatcher room for every capability its phase can run", async () => {
    const { stages } = await compiled();
    for (const route of phaseRoutes()) {
      const dispatchers = stages.filter((stage) => stage.plan_path === route.planPath);
      expect(dispatchers.length, `nothing reads ${route.planPath}`).toBeGreaterThan(0);
      for (const dispatcher of dispatchers) {
        // A ceiling below the phase's capability count rejects the whole plan
        // the moment a round legitimately needs two of them.
        expect(dispatcher.max_actions ?? 0,
          `${dispatcher.id} cannot run every capability its phase routes to it`)
          .toBeGreaterThanOrEqual(capabilitiesOfPhase(route.phase).length);
        expect(dispatcher.outputs).toContain(route.reportPath);
      }
    }
  });

  it("gives every agent-run capability the tool ceiling its template declares", async () => {
    const { catalog } = await compiled();
    for (const action of catalog) {
      const ceiling = toolCeilingFor(action.id);
      if (ceiling.length === 0) {
        // A script action has no harness tools to grant, and the kernel's
        // runtime-capability check refuses a ceiling on one.
        expect(action.allowed_tools ?? []).toEqual([]);
        continue;
      }
      // Emitted for every runtime that can enforce it. Keyed on "the manifest
      // left the runtime unset", an operator who explicitly selected an agent
      // runtime got an empty ceiling — which now grants nothing, so the
      // materializer's request would be refused outright.
      expect(action.allowed_tools, `${action.id} lost its ceiling`).toEqual(ceiling);
    }
  });
});
