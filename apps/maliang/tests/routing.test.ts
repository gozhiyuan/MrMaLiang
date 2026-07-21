import { describe, expect, it } from "vitest";
import { findContract, resolveInvocation } from "../src/routing.js";

describe("routing registry", () => {
  it("matches the longest command path", () => {
    expect(findContract(["research", "prepare", "survey"])?.commandPath).toEqual(["research", "prepare"]);
    expect(findContract(["sync", "survey"])?.commandPath).toEqual(["sync"]);
    expect(findContract(["definitely-not-a-command"])).toBeNull();
  });

  it("routes a convenience verb to the writing component by default", () => {
    const r = resolveInvocation(["sync", "survey"], {});
    expect(r).toMatchObject({ kind: "route", component: "writing", workspaceName: "survey" });
  });

  it("honors --component experiment on shared verbs", () => {
    const r = resolveInvocation(["validate", "study", "--component", "experiment"], {});
    expect(r).toMatchObject({ kind: "route", component: "experiment", workspaceName: "study" });
    if (r.kind === "route") expect(r.componentTokens).not.toContain("--component");
  });

  it("routes bare validate to experiment by default and validate config to writing", () => {
    expect(resolveInvocation(["validate", "study"], {})).toMatchObject({ kind: "route", component: "experiment", workspaceName: "study" });
    expect(resolveInvocation(["validate", "config", "survey"], {})).toMatchObject({ kind: "route", component: "writing", workspaceName: "survey" });
  });

  it("uses a forced namespace component and rejects a conflicting --component", () => {
    expect(resolveInvocation(["sync", "s"], { forcedComponent: "experiment" })).toMatchObject({ component: "experiment" });
    expect(resolveInvocation(["sync", "s", "--component", "writing"], { forcedComponent: "experiment" }).kind).toBe("error");
  });

  it("records no workspace for inspection commands", () => {
    const r = resolveInvocation(["mode", "list"], {});
    expect(r).toMatchObject({ kind: "route", workspaceName: null, workspaceTokenIndex: null });
  });

  it("keeps runtimes and raw status writing-only", () => {
    expect(resolveInvocation(["runtimes", "survey", "--component", "experiment"], {}).kind).toBe("error");
    expect(resolveInvocation(["status", "survey"], { forcedComponent: "writing" })).toMatchObject({ kind: "route", component: "writing" });
  });

  it("errors on an unknown verb and a missing required workspace", () => {
    expect(resolveInvocation(["reserch", "prepare", "s"], {}).kind).toBe("error");
    expect(resolveInvocation(["sync"], {}).kind).toBe("error");
  });

  it("rejects an option before the required workspace positional", () => {
    expect(resolveInvocation(["sync", "--json", "survey"], {}).kind).toBe("error");
  });
});
