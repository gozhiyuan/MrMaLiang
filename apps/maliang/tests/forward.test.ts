import { describe, expect, it } from "vitest";
import { buildForwardArgs, componentSubdir } from "../src/forward.js";
import { resolveInvocation } from "../src/routing.js";
import type { MaliangProject } from "../src/project.js";

const project: MaliangProject = {
  version: 1,
  project: { id: "p", template: "paper.empirical" },
  components: { writing: { workspace: "writing" }, experiment: { workspace: "experiment" } },
  handoff: { mode: "none", state: "not_required" },
};

describe("component resolution", () => {
  it("returns the subdir for a present component and throws for an absent one", () => {
    expect(componentSubdir(project, "writing")).toBe("writing");
    const writingOnly = { ...project, components: { writing: { workspace: "writing" } } } as MaliangProject;
    expect(componentSubdir(writingOnly, "writing")).toBe("writing");
    expect(() => componentSubdir(writingOnly, "experiment")).toThrow(/experiment/);
  });

  it("replaces only the workspace positional and leaves relative flag paths intact", () => {
    const r = resolveInvocation(["research", "import-experiment", "survey", "--manifest", "../ext/m.json"], {});
    if (r.kind !== "route") throw new Error("expected route");
    const args = buildForwardArgs(r, "/abs/survey/writing");
    expect(args).toEqual(["research", "import-experiment", "/abs/survey/writing", "--manifest", "../ext/m.json"]);
  });

  it("forwards inspection commands unchanged", () => {
    const r = resolveInvocation(["mode", "list"], {});
    if (r.kind !== "route") throw new Error("expected route");
    expect(buildForwardArgs(r, "/unused")).toEqual(["mode", "list"]);
  });
});
