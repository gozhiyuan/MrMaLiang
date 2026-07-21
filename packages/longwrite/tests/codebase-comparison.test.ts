import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairCodebaseComparison, validateCodebaseComparison, CodebaseComparisonPacket } from "../src/lib/research/codebase-comparison.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

async function workspace(): Promise<{ root: string; a: string; b: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-codebase-comparison-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "codebases"), { recursive: true });
  await fs.mkdir(path.join(root, "evidence"), { recursive: true });
  const record = (id: string) => ({ version: 1, id, source: `https://github.com/example/${id}.git`, requested_ref: "main", resolved_commit: "a".repeat(40), title: id, role: id === "alpha" ? "primary_artifact" : "supplementary_artifact", snapshot_path: `codebases/${id}/snapshot`, files: [{ path: "README.md", bytes: 100 }], generated_at: "2026-01-01T00:00:00.000Z" });
  await fs.writeFile(path.join(root, "codebases", "manifest.json"), JSON.stringify({ version: 1, codebases: [record("alpha"), record("beta")] }), "utf8");
  const alpha = "[codebase:alpha:README.md#L1-L8]";
  const beta = "[codebase:beta:README.md#L1-L8]";
  await fs.writeFile(path.join(root, "evidence", "codebase-chunks.jsonl"), [
    JSON.stringify({ id: "a", codebase_id: "alpha", path: "README.md", start_line: 1, end_line: 8, text: "alpha" }),
    JSON.stringify({ id: "b", codebase_id: "beta", path: "README.md", start_line: 1, end_line: 8, text: "beta" }),
  ].join("\n") + "\n", "utf8");
  return { root, a: alpha, b: beta };
}

function packet(a: string, b: string) {
  return {
    version: 1 as const,
    codebases: [
      { codebase_id: "alpha", purpose: "Alpha provides a demonstrable primary purpose.", architecture_summary: "Alpha exposes a grounded component boundary and interface.", license: "MIT", extension_points: ["documented plugin interface"], limitations: ["no benchmark evidence is claimed"], locators: [a] },
      { codebase_id: "beta", purpose: "Beta provides a demonstrable supplementary purpose.", architecture_summary: "Beta exposes a separately grounded interface and boundary.", license: null, extension_points: ["documented adapter interface"], limitations: ["no runtime conclusion is claimed"], locators: [b] },
    ],
    comparisons: [{ dimension: "documented extension boundary", codebase_ids: ["alpha", "beta"], synthesis: "The repositories expose different documented extension boundaries without implying measured superiority.", locators: [a, b] }],
  };
}

describe("repository comparison packets", () => {
  it("normalizes a locator-valid multi-repository comparison", async () => {
    const { root, a, b } = await workspace();
    await fs.writeFile(path.join(root, "evidence", "codebase-comparison.raw.json"), JSON.stringify(packet(a, b)), "utf8");
    await expect(repairCodebaseComparison(root)).resolves.toMatchObject({ normalized: false });
    const canonical = CodebaseComparisonPacket.parse(JSON.parse(await fs.readFile(path.join(root, "evidence", "codebase-comparison.json"), "utf8")));
    await expect(validateCodebaseComparison(root, canonical)).resolves.toBeUndefined();
  });

  it("rejects cross-repository synthesis that lacks evidence from one compared repository", async () => {
    const { root, a, b } = await workspace();
    const invalid = packet(a, b);
    invalid.comparisons[0]!.locators = [a, a];
    await fs.writeFile(path.join(root, "evidence", "codebase-comparison.raw.json"), JSON.stringify(invalid), "utf8");
    await expect(repairCodebaseComparison(root)).rejects.toThrow(/invalid repository comparison packet/i);
    expect(await fs.readFile(path.join(root, "reports", "codebase-comparison-repair.md"), "utf8")).toContain("no locator from beta");
  });
});
