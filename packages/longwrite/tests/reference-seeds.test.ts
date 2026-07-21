import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceReferenceSeeds, scholarlyReferenceSeed } from "../src/lib/research/reference-seeds.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

async function workspaceWithLinks(links: string[]): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-reference-seeds-"));
  tempDirs.push(workspace);
  await fs.writeFile(path.join(workspace, "longwrite.yaml"), [
    "version: 1", "project:", "  id: reference-seeds", "  artifact_type: research_paper", "  mode: auto_research_agentic",
    "research: {}", "writing:", "  reference_links:", ...links.map((link) => `    - ${link}`),
    "publication: {}", "figures: {}", "review: {}", "execution: {}", "",
  ].join("\n"), "utf8");
  return workspace;
}

describe("authoritative scholarly reference seeds", () => {
  it("recognizes exact arXiv, DOI, and OpenReview links but leaves ordinary pages as context", () => {
    expect(scholarlyReferenceSeed("https://arxiv.org/pdf/2401.01234.pdf")).toMatchObject({ kind: "arxiv", value: "2401.01234" });
    expect(scholarlyReferenceSeed("https://doi.org/10.1234/Demo.5")).toMatchObject({ kind: "doi", value: "10.1234/demo.5" });
    expect(scholarlyReferenceSeed("https://openreview.net/forum?id=abc-123")).toMatchObject({ kind: "openreview", value: "abc-123" });
    expect(scholarlyReferenceSeed("https://example.com/paper.html")).toBeNull();
  });

  it("resolves a DOI as a deterministic source and records non-scholarly links only as context", async () => {
    const workspace = await workspaceWithLinks(["https://doi.org/10.1234/demo.5", "https://example.com/project"]);
    const fetchImpl = (async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("10.1234%2Fdemo.5");
      return new Response(JSON.stringify({ message: {
        DOI: "10.1234/demo.5", title: ["A verified work"], author: [{ given: "Ada", family: "Lovelace" }],
        issued: { "date-parts": [[2025]] }, "container-title": ["Verified Venue"], type: "journal-article", URL: "https://doi.org/10.1234/demo.5",
      } }), { status: 200 });
    }) as typeof fetch;
    const result = await resolveWorkspaceReferenceSeeds(workspace, "verified systems", fetchImpl);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ title: "A verified work", identifiers: { doi: "10.1234/demo.5" } });
    const artifact = JSON.parse(await fs.readFile(path.join(workspace, "sources", "reference-seeds.json"), "utf8"));
    expect(artifact.seeds).toHaveLength(1);
    expect(artifact.failures).toEqual([]);
  });

  it("fails closed when a recognized authoritative link cannot resolve", async () => {
    const workspace = await workspaceWithLinks(["https://doi.org/10.1234/missing"]);
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    await expect(resolveWorkspaceReferenceSeeds(workspace, "missing paper", fetchImpl)).rejects.toThrow(/failed to resolve 1 authoritative/i);
    expect(await fs.readFile(path.join(workspace, "reports", "reference-seeds.md"), "utf8")).toContain("HTTP 404");
  });
});
