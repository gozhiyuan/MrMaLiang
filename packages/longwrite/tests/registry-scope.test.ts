import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GLOBAL_SCOPE, scopeKey, scopeLabel, writeScopeIndex } from "../src/lib/registry/scope.js";

/** The kernel's storage pattern for an observation scope. A key that cannot
 * match this cannot be stored, so it is asserted here rather than discovered
 * on the wire. */
const KERNEL_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$|^$/;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-scope-"));
  dirs.push(dir);
  return dir;
}

describe("canonical scope keys", () => {
  it("accepts a free-form operator label and yields a storable key", () => {
    const key = scopeKey("section", "3. Related Work — Memory & Planning");
    expect(key).toMatch(KERNEL_SCOPE);
  });

  it("is stable for one kind and label", () => {
    expect(scopeKey("section", "Related Work")).toBe(scopeKey("section", "Related Work"));
  });

  it("does not collide for labels that slugify identically", () => {
    // Both slugify to `related-work`; the digest is what keeps them apart.
    expect(scopeKey("section", "Related Work")).not.toBe(scopeKey("section", "related work"));
  });

  it("does not collide across kinds", () => {
    expect(scopeKey("section", "memory")).not.toBe(scopeKey("taxonomy_cell", "memory"));
  });

  it("represents the global scope as the empty string", () => {
    expect(scopeKey("global", "anything")).toBe(GLOBAL_SCOPE);
    expect(GLOBAL_SCOPE).toBe("");
    expect(GLOBAL_SCOPE).toMatch(KERNEL_SCOPE);
  });

  it("round-trips the operator's label through the index", async () => {
    const dir = await workspace();
    const key = scopeKey("taxonomy_cell", "Agent Memory");
    await writeScopeIndex(dir, [{ key, kind: "taxonomy_cell", label: "Agent Memory" }]);
    expect(await scopeLabel(dir, key)).toBe("Agent Memory");
  });

  it("falls back to the key when no index has been written", async () => {
    const dir = await workspace();
    const key = scopeKey("section", "Method");
    expect(await scopeLabel(dir, key)).toBe(key);
  });
});
