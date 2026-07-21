import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toJsonl } from "../src/lib/research/jsonl.js";
import type { CitationPlanEntry, ClassifiedSource } from "../src/lib/research/types.js";
import { draftSectionWorkspace } from "../src/lib/writing/draft.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-draft-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("draftSectionWorkspace", () => {
  it("writes a cited section from citation-plan and classified sources", async () => {
    const ws = await makeWorkspace();
    const sources: ClassifiedSource[] = [
      {
        id: "source-1",
        title: "Grounded Research Agents",
        authors: ["Ada Lovelace"],
        year: 2026,
        venue: "LongWrite Test",
        url: "https://example.org/source-1",
        abstract: "Research agents should cite sources.",
        source: "seed",
        topics: ["research"],
        quality_score: 0.9,
        score_rationale: "test",
        citation_depth: "A",
        citation_depth_rationale: "test",
      },
    ];
    const plan: CitationPlanEntry[] = [
      { section_id: "section-1", section_title: "Background", source_ids: ["source-1"] },
    ];
    await fs.writeFile(path.join(ws, "sources/classified_sources.jsonl"), toJsonl(sources), "utf-8");
    await fs.writeFile(path.join(ws, "sources/citation_plan.jsonl"), toJsonl(plan), "utf-8");
    await fs.mkdir(path.join(ws, "evidence"), { recursive: true });
    await fs.writeFile(path.join(ws, "evidence", "section-section-1.json"), JSON.stringify({
      version: 1,
      section_id: "section-1",
      section_title: "Background",
      query: "background",
      generated_at: "2026-01-01T00:00:00.000Z",
      source_ids: ["source-1"],
      chunks: [{
        id: "source-1:p12",
        source_id: "source-1",
        citation_key: "lovelace2026",
        locator: { heading: "Evidence", paragraph: 12 },
        text: "Research agents should cite attributable source passages when making factual claims. ".repeat(3),
        chars: 240,
      }],
    }, null, 2), "utf-8");

    await draftSectionWorkspace(ws, ["chapters/section-1.md"]);
    const chapter = await fs.readFile(path.join(ws, "chapters/section-1.md"), "utf-8");
    expect(chapter).toContain("# Background");
    expect(chapter).toContain("[source:source-1:p12]");
  });

  it("refuses to scaffold factual research prose without an evidence packet", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, "sources/classified_sources.jsonl"), "", "utf-8");
    await fs.writeFile(path.join(ws, "sources/citation_plan.jsonl"), "", "utf-8");
    await expect(draftSectionWorkspace(ws, ["chapters/section-1.md"])).rejects.toThrow(/no evidence chunks/);
  });
});
