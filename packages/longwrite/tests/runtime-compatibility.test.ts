import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const contract = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "..", "..", "runtime-compatibility.json"), "utf-8"));

describe("runtime compatibility", () => {
  it("requires MalaClaw 3.x", () => {
    expect(contract.malaclaw.supported).toBe(">=3.0.0 <4.0.0");
    expect(contract.sdk.supported).toBe(">=3.0.0 <4.0.0");
  });

  it("declares IR version 2", () => {
    expect(contract.ir_version).toBe(2);
  });

  it("records the tested runtime revision", () => {
    expect(contract.malaclaw.tested_with).toMatch(/^3\./);
  });

  it("explains what 3.0 requires, so an operator can act on a rejection", () => {
    expect(contract.malaclaw.note).toMatch(/contract|observation|transactional/i);
  });

  it("pins the same major in the workspace devDependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    expect(pkg.devDependencies.malaclaw).toMatch(/3\.|file:/);
  });
});
