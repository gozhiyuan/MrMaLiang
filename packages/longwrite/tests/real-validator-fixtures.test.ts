import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { validateWorkflowSemantics } from "malaclaw/dist/lib/workflow/validate.js";
import { WorkflowDef } from "malaclaw/dist/lib/schema.js";

/** Every generated fixture, through the REAL MalaClaw validator.
 *
 * The golden tests call `Manifest.parse`, which checks schema SHAPE. It does
 * not run `validateWorkflowSemantics`, which is what an actual
 * `malaclaw flow run` runs — so a manifest could be structurally perfect and
 * rejected by the engine the moment an operator tried to use it. Every
 * LongExperiment fixture was in exactly that state: `ir_version: 2` with
 * `require_declared_effects: true`, and output-producing stages declaring no
 * envelope at all.
 *
 * Shape is not acceptance. This test asks the question the operator asks. */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "compiled");

type Manifest = {
  project?: { attached_agents?: string[] };
  workflow?: unknown;
};

async function fixtures(): Promise<Array<{ name: string; manifest: Manifest }>> {
  const names = (await fs.readdir(fixturesDir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    manifest: JSON.parse(await fs.readFile(path.join(fixturesDir, name), "utf-8")) as Manifest,
  })));
}

describe("every generated LongWrite manifest is accepted by the real validator", () => {
  it("has fixtures to check", async () => {
    expect((await fixtures()).length).toBeGreaterThan(0);
  });

  it("passes semantic validation with no errors", async () => {
    const failures: string[] = [];
    for (const { name, manifest } of await fixtures()) {
      // Parsed with the ENGINE's schema, not a local copy: a manifest the
      // engine's own parser rejects is one no operator can run.
      const workflow = WorkflowDef.parse(manifest.workflow);
      const result = validateWorkflowSemantics(
        workflow, new Set(manifest.project?.attached_agents ?? []));
      if (result.errors.length > 0) failures.push(`${name}:\n    ${result.errors.join("\n    ")}`);
    }
    expect(failures, `manifests the engine would refuse to run:\n  ${failures.join("\n  ")}`)
      .toEqual([]);
  });

  it("declares an envelope for every output-producing unit it promises one for", async () => {
    // `require_declared_effects` is the promise that transaction isolation is
    // real for this workflow. A manifest that sets it and still leaves
    // output-producing stages undeclared is claiming a guarantee it does not
    // have — and the engine says so, per unit, rather than at the end of a run.
    const failures: string[] = [];
    for (const { name, manifest } of await fixtures()) {
      const workflow = WorkflowDef.parse(manifest.workflow);
      if (workflow.require_declared_effects !== true) continue;
      const result = validateWorkflowSemantics(
        workflow, new Set(manifest.project?.attached_agents ?? []));
      if (result.underspecified.length > 0) {
        failures.push(`${name}: ${result.underspecified.length} underspecified unit(s)`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("names an owner every manifest actually attaches", async () => {
    // An owner absent from `attached_agents` is a semantic error the shape
    // check cannot see, and it fails the run at startup rather than at the
    // stage that names it.
    const failures: string[] = [];
    for (const { name, manifest } of await fixtures()) {
      const workflow = WorkflowDef.parse(manifest.workflow);
      const result = validateWorkflowSemantics(
        workflow, new Set(manifest.project?.attached_agents ?? []));
      const owners = result.errors.filter((error) => error.includes("is not an agent"));
      if (owners.length > 0) failures.push(`${name}: ${owners.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});
