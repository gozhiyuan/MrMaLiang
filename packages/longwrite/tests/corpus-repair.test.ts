import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairBibliography, repairCitationPlan, repairSourceMetadata } from "../src/lib/research/corpus-repair.js";
import type { ClassifiedSource, RawSource } from "../src/lib/research/types.js";
import type { ResearchProvider } from "../src/lib/research/providers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-corpus-repair-"));
  roots.push(root);
  await Promise.all(["sources", "reports", "chapters"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  return root;
}

function source(id = "paper"): ClassifiedSource {
  return {
    id, title: "Repairable Metadata Paper", authors: ["Ada Lovelace"], year: 2026,
    venue: "unknown", url: "https://dead.example/paper", abstract: "A fixture about repairable metadata.",
    source: "crossref", topics: ["repair"], quality_score: 0.8, score_rationale: "fixture",
    citation_depth: "B", citation_depth_rationale: "fixture",
  };
}

function provider(results: RawSource[]): ResearchProvider {
  return { id: "crossref", search: async () => results };
}

const liveFetch: typeof fetch = async (input) => new Response("", {
  status: String(input).includes("doi.org") ? 200 : 404,
});

describe("corpus repair", () => {
  it("repairs only bibliography-derived artifacts without changing the citation plan", async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), `${JSON.stringify(source())}\n`);
    await fs.writeFile(path.join(root, "sources", "citation_plan.jsonl"), `${JSON.stringify({ section_id: "real", section_title: "Real", source_ids: ["paper"] })}\n`);

    await repairBibliography(root);

    expect(await fs.readFile(path.join(root, "sources", "citation_plan.jsonl"), "utf8"))
      .toContain('"section_id":"real"');
    expect(await fs.readFile(path.join(root, "sources", "bibliography.bib"), "utf8")).toContain("@misc");
  });

  it("repairs a broken plan from real outline sections without touching source metadata", async () => {
    const root = await workspace();
    const record = { ...source(), identifiers: { doi: "10.1000/original" } };
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), `${JSON.stringify(record)}\n`);
    await fs.writeFile(path.join(root, "outline.json"), JSON.stringify({ sections: [
      { id: "evidence", title: "Evidence", keywords: ["repair"] },
    ] }));
    await fs.writeFile(path.join(root, "sources", "citation_plan.jsonl"), `${JSON.stringify({ section_id: "evidence", section_title: "Evidence", source_ids: ["missing"] })}\n`);

    await repairCitationPlan(root);

    expect(await fs.readFile(path.join(root, "sources", "citation_plan.jsonl"), "utf8")).toContain('"source_ids":["paper"]');
    expect(await fs.readFile(path.join(root, "sources", "classified_sources.jsonl"), "utf8")).toContain('"doi":"10.1000/original"');
  });

  it("looks up missing identity metadata, validates a replacement URL, and re-verifies it", async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), `${JSON.stringify(source())}\n`);
    await fs.writeFile(path.join(root, "sources", "citation-verification.jsonl"),
      `${JSON.stringify({ source_id: "paper", status: "dead", url: "https://dead.example/paper" })}\n`);
    const candidate: RawSource = {
      ...source("provider-paper"), url: "https://doi.org/10.1000/repaired", venue: "ICLR",
      identifiers: { doi: "10.1000/repaired" }, links: { canonical_url: "https://doi.org/10.1000/repaired" },
    };

    const result = await repairSourceMetadata(root, { provider: provider([candidate]), fetchImpl: liveFetch });

    expect(result.replacementNeeded).toEqual([]);
    const repaired = JSON.parse((await fs.readFile(path.join(root, "sources", "classified_sources.jsonl"), "utf8")).trim());
    expect(repaired.identifiers.doi).toBe("10.1000/repaired");
    expect(repaired.url).toBe("https://doi.org/10.1000/repaired");
    expect((await fs.readFile(path.join(root, "sources", "citation-verification.jsonl"), "utf8"))).toContain('"status":"live"');
    expect((await fs.readFile(path.join(root, "sources", "source-identities.jsonl"), "utf8"))).toContain('"doi":"10.1000/repaired"');
  });

  it("emits targeted acquisition requests when no identity can be recovered", async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), `${JSON.stringify(source())}\n`);

    const result = await repairSourceMetadata(root, { provider: provider([]), fetchImpl: liveFetch });

    expect(result.replacementNeeded).toEqual(["paper"]);
    const requests = JSON.parse(await fs.readFile(path.join(root, "sources", "metadata-replacement-requests.json"), "utf8"));
    expect(requests.requests).toMatchObject([{ source_id: "paper", query: "Repairable Metadata Paper" }]);
  });
});
