import os from "node:os";
import { describe, expect, it } from "vitest";
import { childExitStatus } from "../src/proxy.js";

describe("childExitStatus", () => {
  it("passes through a zero exit code", () => {
    expect(childExitStatus(0, null)).toBe(0);
  });

  it("passes through a nonzero exit code", () => {
    expect(childExitStatus(3, null)).toBe(3);
  });

  it("maps SIGINT to 128 + the platform signal number", () => {
    expect(childExitStatus(null, "SIGINT")).toBe(128 + os.constants.signals.SIGINT);
  });

  it("maps SIGTERM to 128 + the platform signal number", () => {
    expect(childExitStatus(null, "SIGTERM")).toBe(128 + os.constants.signals.SIGTERM);
  });

  it("defaults to 1 when there is neither a code nor a signal", () => {
    expect(childExitStatus(null, null)).toBe(1);
  });
});
