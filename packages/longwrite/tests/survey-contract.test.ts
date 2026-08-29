import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateSurveyContract } from "../src/lib/research/survey-contract.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-survey-contract-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), ["a", "b", "c", "d", "e"].map((id) => JSON.stringify({
    id, title: id, authors: [], year: 2025, venue: "Test", url: `https://example.test/${id}`, abstract: "", source: "crossref", topics: [], quality_score: 1, score_rationale: "", citation_depth: "A", citation_depth_rationale: "",
  })).join("\n") + "\n", "utf-8");
  return ws;
}

it("accepts explicit outline roles without relying on title keywords", async () => {
  const ws = await workspace();
  await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({ sections: [
    { id: "intro", title: "Scope", role: "introduction_gap_contributions", keywords: ["scope", "agents"] },
    { id: "framework", title: "Lens", role: "multi_axis_taxonomy", keywords: ["taxonomy", "framework"] },
    { id: "memory", title: "Persistent state", role: "method_family", keywords: ["memory", "retrieval"] },
    { id: "planning", title: "Deliberation", role: "method_family", keywords: ["planning", "decomposition"] },
    { id: "related", title: "Positioning", role: "related_work_differentiation", keywords: ["related work", "comparison"] },
    { id: "limits", title: "What remains", role: "limitations_future_work", keywords: ["limitations", "future work"] },
  ] }), "utf-8");

  const { report } = await evaluateSurveyContract(ws);
  expect(report.pass).toBe(true);
});

it("repairs keywords omitted by a structural outline reopen before evidence allocation", async () => {
  const ws = await workspace();
  await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({ sections: [
    { id: "intro", title: "Research scope and harnesses", role: "introduction_gap_contributions" },
    { id: "framework", title: "Evidence frame", role: "multi_axis_taxonomy", keywords: ["evidence", "framework"] },
    { id: "memory", title: "Persistent state", role: "method_family", keywords: ["memory", "retrieval"] },
    { id: "planning", title: "Deliberation", role: "method_family", keywords: ["planning", "decomposition"] },
    { id: "related", title: "Positioning", role: "related_work_differentiation", keywords: ["related work", "comparison"] },
    { id: "limits", title: "What remains", role: "limitations_future_work", keywords: ["limitations", "future work"] },
  ] }), "utf-8");

  const { report } = await evaluateSurveyContract(ws);
  const repaired = JSON.parse(await fs.readFile(path.join(ws, "outline.json"), "utf-8")) as { sections: Array<{ id: string; keywords?: string[] }> };

  expect(report.pass).toBe(true);
  expect(repaired.sections.find((section) => section.id === "intro")?.keywords).toEqual(["research", "scope", "harnesses"]);
});

it("restores stable chapter IDs after a one-to-one structural outline rename", async () => {
  const ws = await workspace();
  const oldIds = [
    "section-01-introduction", "section-02-taxonomy", "section-03-memory",
    "section-04-planning", "section-05-related-work", "section-06-limitations",
  ];
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await Promise.all(oldIds.map((id) => fs.writeFile(path.join(ws, "chapters", `${id}.md`), `# ${id}\n`, "utf-8")));
  await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({ sections: [
    { id: "section-01-reframed-introduction", title: "Scope", role: "introduction_gap_contributions", keywords: ["scope"] },
    { id: "section-02-evidence-frame", title: "Lens", role: "multi_axis_taxonomy", keywords: ["taxonomy"] },
    { id: "section-03-persistent-state", title: "Persistent state", role: "method_family", keywords: ["memory"] },
    { id: "section-04-deliberation", title: "Deliberation", role: "method_family", keywords: ["planning"] },
    { id: "section-05-positioning", title: "Positioning", role: "related_work_differentiation", keywords: ["comparison"] },
    { id: "section-06-open-questions", title: "What remains", role: "limitations_future_work", keywords: ["limitations"] },
  ] }), "utf-8");

  const { report } = await evaluateSurveyContract(ws);
  const repaired = JSON.parse(await fs.readFile(path.join(ws, "outline.json"), "utf-8")) as { sections: Array<{ id: string }> };

  expect(report.pass).toBe(true);
  expect(repaired.sections.map((section) => section.id)).toEqual(oldIds);
});
