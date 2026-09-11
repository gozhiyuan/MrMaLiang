import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { validateWorkflowSemantics } from "malaclaw/dist/lib/workflow/validate.js";
import { WorkflowDef } from "malaclaw/dist/lib/schema.js";

/** Every generated LongExperiment manifest, through the REAL validator.
 *
 * The golden tests check schema SHAPE. They do not run the semantic validation
 * an actual `malaclaw flow run` runs, so every one of these manifests could be
 * — and was — structurally perfect and refused by the engine at startup:
 * `ir_version: 2` with `require_declared_effects: true`, and output-producing
 * stages declaring no envelope at all. */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "compiled");

type Manifest = { project?: { attached_agents?: string[] }; workflow?: unknown };

async function fixtures(): Promise<Array<{ name: string; manifest: Manifest }>> {
  const names = (await fs.readdir(fixturesDir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    manifest: JSON.parse(await fs.readFile(path.join(fixturesDir, name), "utf-8")) as Manifest,
  })));
}

function check(manifest: Manifest) {
  const workflow = WorkflowDef.parse(manifest.workflow);
  return {
    workflow,
    result: validateWorkflowSemantics(workflow, new Set(manifest.project?.attached_agents ?? [])),
  };
}

describe("every generated LongExperiment manifest is accepted by the real validator", () => {
  it("has fixtures to check", async () => {
    expect((await fixtures()).length).toBeGreaterThan(0);
  });

  it("passes semantic validation with no errors", async () => {
    const failures: string[] = [];
    for (const { name, manifest } of await fixtures()) {
      const { result } = check(manifest);
      if (result.errors.length > 0) failures.push(`${name}:\n    ${result.errors.join("\n    ")}`);
    }
    expect(failures, `manifests the engine would refuse to run:\n  ${failures.join("\n  ")}`)
      .toEqual([]);
  });

  it("keeps the promise `require_declared_effects` makes", async () => {
    const failures: string[] = [];
    for (const { name, manifest } of await fixtures()) {
      const { workflow, result } = check(manifest);
      if (workflow.require_declared_effects !== true) continue;
      if (result.underspecified.length > 0) {
        failures.push(`${name}:\n    ${result.underspecified.join("\n    ")}`);
      }
    }
    expect(failures, `units promising isolation without declaring an envelope:\n  ${failures.join("\n  ")}`)
      .toEqual([]);
  });
});
