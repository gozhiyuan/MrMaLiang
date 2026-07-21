import { describe, expect, it } from "vitest";
import { validateInitPassthrough } from "../src/init-passthrough.js";

describe("init passthrough policy", () => {
  it("accepts allowed customization flags and preserves order", () => {
    const r = validateInitPassthrough(["--author", "Name", "Coauthor", "--taxonomy", "a", "b", "--citation-style", "author_year", "--target-length-words", "40000"], { hasWriting: true });
    expect(r).toEqual({ ok: true, args: ["--author", "Name", "Coauthor", "--taxonomy", "a", "b", "--citation-style", "author_year", "--target-length-words", "40000"] });
  });

  it("rejects reserved structural flags with an actionable message", () => {
    const r = validateInitPassthrough(["--research-paper-kind", "empirical"], { hasWriting: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--research-paper-kind.*template|native/i);
  });

  it("rejects unknown options (fail closed)", () => {
    expect(validateInitPassthrough(["--totally-made-up"], { hasWriting: true }).ok).toBe(false);
  });

  it("rejects any passthrough for a writing-less (experiment-only) template", () => {
    const r = validateInitPassthrough(["--author", "Name"], { hasWriting: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/experiment-only|no writing component/i);
  });

  it("rejects duplicate non-repeatable options and accepts real publication settings", () => {
    expect(validateInitPassthrough(["--author", "A", "--author", "B"], { hasWriting: true }).ok).toBe(false);
    expect(validateInitPassthrough(["--submission-target", "custom", "--page-limit", "12", "--document-class", "venue", "--submission-template-dir", "template"], { hasWriting: true }).ok).toBe(true);
  });
});
