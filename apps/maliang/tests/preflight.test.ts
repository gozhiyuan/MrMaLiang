import { describe, expect, it } from "vitest";
import { assembleUnifiedReport, foldWritingReport } from "../src/preflight.js";

const ok = { status: "pass" as const, checks: [] };
const bad = { status: "fail" as const, checks: [{ id: "matplotlib", pass: false, finding: "missing" }] };
const na = { status: "not_required" as const, checks: [] };
const success = { code: 0, signal: null, error: undefined };

describe("unified preflight assembly", () => {
  it("passes when no required component fails", () => {
    expect(assembleUnifiedReport({ writing: ok, experiment: na, runtime: ok })).toMatchObject({ version: 1, overall: "pass" });
  });
  it("fails when any required component fails and ignores not_required", () => {
    expect(assembleUnifiedReport({ writing: bad, experiment: na, runtime: ok }).overall).toBe("fail");
    expect(assembleUnifiedReport({ writing: ok, experiment: na, runtime: ok }).overall).toBe("pass");
  });
});

describe("foldWritingReport", () => {
  it("folds a valid passing report to status pass and passes checks through", () => {
    const checks = [{ id: "word_count", pass: true, finding: "within range" }];
    expect(foldWritingReport(JSON.stringify({ pass: true, checks }), success, true)).toEqual({ status: "pass", checks });
  });

  it("folds a valid failing report to status fail", () => {
    const checks = [{ id: "word_count", pass: false, finding: "too short" }];
    expect(foldWritingReport(JSON.stringify({ pass: false, checks }), { code: 1, signal: null }, true)).toEqual({ status: "fail", checks });
  });

  it("folds a null (crashed, no file) report to status fail with a writing_preflight finding mentioning the exit code", () => {
    const result = foldWritingReport(null, { code: 1, signal: null }, false);
    expect(result.status).toBe("fail");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: "writing_preflight", pass: false });
    expect(result.checks[0].finding).toContain("exit 1");
  });

  it("folds a null report with an unknown exit code", () => {
    const result = foldWritingReport(null, { code: null, signal: null }, false);
    expect(result.checks[0].finding).toContain("exit unknown");
  });

  it("folds a non-JSON report to status fail with a not-valid-JSON finding", () => {
    const result = foldWritingReport("not json {{{", success, true);
    expect(result.status).toBe("fail");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: "writing_preflight", pass: false });
    expect(result.checks[0].finding).toContain("not valid JSON");
  });

  it("fails closed when the report is stale, malformed, or inconsistent with the child exit", () => {
    const valid = JSON.stringify({ pass: true, checks: [] });
    expect(foldWritingReport(valid, success, false).status).toBe("fail");
    expect(foldWritingReport(valid, { code: 1, signal: null }, true).status).toBe("fail");
    expect(foldWritingReport(JSON.stringify({ pass: true, checks: "bad" }), success, true).status).toBe("fail");
  });
});
