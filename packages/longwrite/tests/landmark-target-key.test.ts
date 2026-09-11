import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { landmarkTargetKey, resolveLandmarkTargets } from "../src/lib/research/landmark.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

const candidate = (name: string, identifiers?: Record<string, string>) => ({
  name, why_canonical: "It introduced the architecture the field now assumes.",
  confidence: "high" as const,
  ...(identifiers ? { expected_identifiers: identifiers } : {}),
});

async function workspace(candidates: unknown[], sources: unknown[]): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-landmark-key-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "research"), { recursive: true });
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "research", "landmark-candidates.json"),
    JSON.stringify({ version: 1, candidates }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("landmark target keys", () => {
  it("derives a stable key from the normalized candidate name", () => {
    expect(landmarkTargetKey(candidate("Attention Is All You Need")))
      .toBe(landmarkTargetKey(candidate("attention is  all you need")));
  });

  it("distinguishes two different landmarks", () => {
    expect(landmarkTargetKey(candidate("Attention Is All You Need")))
      .not.toBe(landmarkTargetKey(candidate("BERT")));
  });

  it("keeps the key stable when a candidate later resolves", async () => {
    // The key must not depend on resolution, or an unresolved target and its
    // later-discovered source would be two different targets.
    const before = await resolveLandmarkTargets(await workspace([candidate("BERT")], []));
    const after = await resolveLandmarkTargets(await workspace([candidate("BERT")],
      [{ id: "s1", title: "BERT", citation_depth: "A", identifiers: {} }]));
    expect(before[0].target_key).toBe(after[0].target_key);
    expect(before[0].resolved_source_id).toBeNull();
    expect(after[0].resolved_source_id).toBe("s1");
  });

  it("records the method that resolved a target", async () => {
    const ws = await workspace([candidate("Attention", { arxiv_id: "1706.03762" })],
      [{ id: "s1", title: "Something Else", citation_depth: "A", identifiers: { arxiv_id: "arXiv:1706.03762" } }]);
    const resolutions = await resolveLandmarkTargets(ws);
    expect(resolutions[0].method).toBe("arxiv_id");
    expect(resolutions[0].resolved_source_id).toBe("s1");
  });

  it("records an unresolved target rather than omitting it", async () => {
    // An unfound landmark must be a visible pending target, not an absence:
    // that is the difference between "search failed" and "never tried".
    const resolutions = await resolveLandmarkTargets(await workspace([candidate("Nowhere")], []));
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].method).toBe("unresolved");
  });

  it("reads the real candidates array, not a landmarks array", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-landmark-shape-"));
    roots.push(ws);
    await fs.mkdir(path.join(ws, "research"), { recursive: true });
    await fs.writeFile(path.join(ws, "research", "landmark-candidates.json"),
      JSON.stringify({ version: 1, landmarks: [{ title: "BERT", resolved_source_id: "s1" }] }), "utf-8");
    await expect(resolveLandmarkTargets(ws)).rejects.toThrow();
  });

  it("returns nothing for a workspace with no candidates file", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-landmark-none-"));
    roots.push(ws);
    expect(await resolveLandmarkTargets(ws)).toEqual([]);
  });
});
