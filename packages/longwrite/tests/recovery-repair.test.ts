import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessFinalReleaseProgress, writeCitationRepairPacket, writeCitedSourceUpgradePacket, writeFinalReleaseBaseline } from "../src/lib/research/recovery-repair.js";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-recovery-repair-"));
  temporaryDirs.push(root);
  await Promise.all(["reports", "reviews", "evidence"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  return root;
}

describe("final-release recovery repairs", () => {
  it("rebuilds the ledger and gives the editor only same-source marker options", async () => {
    const root = await workspace();
    await Promise.all(["chapters", "sources"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
    await fs.writeFile(path.join(root, "chapters", "section-1.md"), "A supported statement [source:missing].\n", "utf-8");
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), JSON.stringify({
      id: "missing", title: "Missing", authors: ["Author"], year: 2025, venue: "Venue", url: "https://example.test/missing",
      abstract: "", source: "test", topics: [], citation_depth: "A",
    }) + "\n", "utf-8");
    await fs.writeFile(path.join(root, "evidence", "citation-ledger.jsonl"), [
      JSON.stringify({ version: 1, section_id: "section-1", source_id: "missing", chapter_path: "chapters/section-1.md", status: "missing_evidence" }),
      JSON.stringify({ version: 1, section_id: "section-1", source_id: "missing", chapter_path: "chapters/section-1.md", status: "missing_evidence" }),
    ].join("\n"), "utf-8");
    await fs.writeFile(path.join(root, "evidence", "section-section-1.json"), JSON.stringify({
      version: 1, section_id: "section-1", section_title: "One", query: "one", generated_at: "now", source_ids: ["missing", "replacement"],
      chunks: [
        { id: "missing:p4", source_id: "missing", citation_key: "missing", locator: { paragraph: 4 }, text: "evidence", chars: 8 },
        { id: "replacement:p2", source_id: "replacement", citation_key: "replacement", locator: { paragraph: 2 }, text: "replacement", chars: 11 },
      ],
    }), "utf-8");

    await expect(writeCitationRepairPacket(root)).resolves.toMatchObject({ items: 1 });
    const packet = JSON.parse(await fs.readFile(path.join(root, "reviews", "citation-repair-packet.json"), "utf-8"));
    expect(packet.repair_items).toEqual([expect.objectContaining({
      chapter_path: "chapters/section-1.md",
      source_id: "missing",
      exact_marker_options: ["[source:missing:p4]"],
    })]);
  });

  it("materializes distinct uncited packet-backed additions using exact section identities", async () => {
    const root = await workspace();
    await Promise.all(["chapters", "sources"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
    await fs.writeFile(path.join(root, "longwrite.yaml"), [
      "version: 1", "project:", "  id: additions", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  release_gates:", "    min_cited_sources: 3", "    min_accepted_cited_ratio: 0",
    ].join("\n"), "utf-8");
    await fs.writeFile(path.join(root, "chapters", "section-01-memory.md"), "Existing claim [source:already:p1].\n", "utf-8");
    const source = (id: string, venue: string, depth: string) => JSON.stringify({
      id, title: `Title ${id}`, authors: ["Author"], year: 2025, venue, url: `https://example.test/${id}`,
      abstract: "", source: "test", topics: [], citation_depth: depth,
    });
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), [
      source("already", "arXiv", "B"), source("new-accepted", "Proceedings of TestConf", "B"), source("new-context", "arXiv", "B"),
    ].join("\n") + "\n", "utf-8");
    await fs.writeFile(path.join(root, "evidence", "section-section-01-memory.json"), JSON.stringify({
      version: 1, section_id: "section-01-memory", section_title: "Memory", query: "memory", generated_at: "now",
      source_ids: ["already", "new-accepted", "new-context"],
      chunks: [
        { id: "already:p1", source_id: "already", citation_key: "already", locator: { paragraph: 1 }, text: "Existing evidence.", chars: 18 },
        { id: "new-accepted:p2", source_id: "new-accepted", citation_key: "new-accepted", locator: { paragraph: 2 }, text: "Accepted packet evidence for a distinct claim.", chars: 46 },
        { id: "new-context:p3", source_id: "new-context", citation_key: "new-context", locator: { paragraph: 3 }, text: "Context packet evidence for a second distinct claim.", chars: 52 },
      ],
    }), "utf-8");
    await fs.writeFile(path.join(root, "evidence", "active-validated-source-evidence.json"), JSON.stringify({
      version: 1,
      entries: [
        { packet: { source_id: "new-accepted", claims: [{ claim: "Accepted evidence supports a distinct claim.", supporting_excerpt: "Accepted packet evidence for a distinct claim.", locator: "paragraph: 2" }] } },
        { packet: { source_id: "new-context", claims: [{ claim: "Context evidence supports a second distinct claim.", supporting_excerpt: "Context packet evidence for a second distinct claim.", locator: "paragraph: 3" }] } },
      ],
    }), "utf-8");

    await expect(writeCitedSourceUpgradePacket(root)).resolves.toMatchObject({ items: 2 });
    const packet = JSON.parse(await fs.readFile(path.join(root, "reviews", "cited-source-upgrade-packet.json"), "utf-8"));
    expect(packet.required_distinct_additions).toBe(2);
    expect(packet.addition_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ chapter_path: "chapters/section-01-memory.md", section_id: "section-01-memory", source_id: "new-accepted", exact_marker: "[source:new-accepted:p2]" }),
      expect.objectContaining({ source_id: "new-context", exact_marker: "[source:new-context:p3]" }),
    ]));
  });

  it("accepts partial measurable progress but refuses a fully unchanged recovery round", async () => {
    const root = await workspace();
    const writeState = async (opts: { cited: number; unresolved: number; claim: number; review: number }) => {
      await fs.writeFile(path.join(root, "reports", "release-gates.json"), JSON.stringify({
        pass: false,
        gates: [{ id: "cited_literature_release_gates", pass: false, findings: [`cited=${opts.cited}; ${opts.cited / 10} per page`] }],
      }), "utf-8");
      await fs.writeFile(path.join(root, "reports", "evidence-audit.json"), JSON.stringify({ missing_evidence: opts.unresolved, metadata_linked: 0, unknown_source: 0 }), "utf-8");
      await fs.writeFile(path.join(root, "reports", "metrics.json"), JSON.stringify({ claim_support_rate: opts.claim, review_score: opts.review }), "utf-8");
    };
    await writeState({ cited: 10, unresolved: 8, claim: 0.7, review: 2 });
    await writeFinalReleaseBaseline(root);
    await writeState({ cited: 12, unresolved: 3, claim: 0.8, review: 2 });
    await expect(assessFinalReleaseProgress(root)).resolves.toMatchObject({ pass: true, improvements: expect.arrayContaining([expect.stringContaining("cited_sources"), expect.stringContaining("ledger_unresolved")]) });

    await writeFinalReleaseBaseline(root);
    await expect(assessFinalReleaseProgress(root)).resolves.toMatchObject({ pass: false, improvements: [] });
  });

  it("rejects a nominal improvement when another protected metric regresses", async () => {
    const root = await workspace();
    const writeState = async (opts: { cited: number; unresolved: number; claim: number; review: number }) => {
      await fs.writeFile(path.join(root, "reports", "release-gates.json"), JSON.stringify({
        pass: false,
        gates: [{ id: "cited_literature_release_gates", pass: false, findings: [`cited=${opts.cited}; ${opts.cited / 10} per page`] }],
      }), "utf-8");
      await fs.writeFile(path.join(root, "reports", "evidence-audit.json"), JSON.stringify({ missing_evidence: opts.unresolved, metadata_linked: 0, unknown_source: 0 }), "utf-8");
      await fs.writeFile(path.join(root, "reports", "metrics.json"), JSON.stringify({ claim_support_rate: opts.claim, review_score: opts.review }), "utf-8");
    };
    await writeState({ cited: 20, unresolved: 2, claim: 0.60, review: 3 });
    await writeFinalReleaseBaseline(root);
    await writeState({ cited: 20, unresolved: 3, claim: 0.70, review: 3 });

    await expect(assessFinalReleaseProgress(root)).resolves.toMatchObject({
      pass: false,
      improvements: expect.arrayContaining([expect.stringContaining("claim_support_rate")]),
    });
    const report = JSON.parse(await fs.readFile(path.join(root, "reports", "final-release-progress.json"), "utf-8"));
    expect(report.regressions).toEqual(expect.arrayContaining([expect.stringContaining("ledger_unresolved")]));
  });

  it("records action acceptance and escalates only wholly stalled repair rounds", async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, "reports", "release-gates.json"), JSON.stringify({
      pass: false,
      gates: [{ id: "landmark_coverage", pass: false }, { id: "review_target", pass: false }],
    }), "utf-8");
    await fs.writeFile(path.join(root, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      actions: [{
        id: "repair-both", tool: "revise_sections", finding_ids: ["landmark_coverage", "review_target"],
        acceptance_criteria: [{ metric: "review_score", operator: "at_least", target: 8 }],
      }],
    }), "utf-8");
    await writeFinalReleaseBaseline(root);

    await assessFinalReleaseProgress(root);
    let metrics = JSON.parse(await fs.readFile(path.join(root, "reports", "metrics.json"), "utf-8"));
    expect(metrics).toMatchObject({ repair_actions_accepted: 0, repair_actions_unmet: 1, repair_stalled_rounds: 1 });
    const acceptance = JSON.parse(await fs.readFile(path.join(root, "reports", "action-acceptance.json"), "utf-8"));
    expect(acceptance.actions[0]).toMatchObject({ execution_status: "completed", acceptance_status: "unmet", unresolved_finding_ids: ["landmark_coverage", "review_target"] });

    await fs.writeFile(path.join(root, "reports", "release-gates.json"), JSON.stringify({
      pass: false,
      gates: [{ id: "landmark_coverage", pass: true }, { id: "review_target", pass: false }],
    }), "utf-8");
    await assessFinalReleaseProgress(root);
    metrics = JSON.parse(await fs.readFile(path.join(root, "reports", "metrics.json"), "utf-8"));
    expect(metrics).toMatchObject({ repair_actions_accepted: 0, repair_actions_unmet: 1, repair_findings_resolved: 1, repair_stalled_rounds: 0 });
  });

  it("excludes metadata-only indexed chunks from citation-upgrade candidates", async () => {
    const root = await workspace();
    await Promise.all(["chapters", "sources"].map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
    await fs.writeFile(path.join(root, "longwrite.yaml"), "version: 1\nproject: { id: filtered, artifact_type: research_paper, mode: auto_research_agentic }\nresearch: { release_gates: { min_cited_sources: 2 } }\n", "utf-8");
    await fs.writeFile(path.join(root, "chapters", "section-1.md"), "Existing [source:existing:p1].\n", "utf-8");
    const source = (id: string) => JSON.stringify({ id, title: id, authors: ["A"], year: 2025, venue: "arXiv", url: `https://example.test/${id}`, abstract: "", source: "test", topics: [], citation_depth: "B" });
    await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), `${source("existing")}\n${source("metadata-only")}\n`, "utf-8");
    await fs.writeFile(path.join(root, "evidence", "section-section-1.json"), JSON.stringify({ version: 1, section_id: "section-1", section_title: "One", query: "one", generated_at: "now", source_ids: ["metadata-only"], chunks: [{ id: "metadata-only:p1", source_id: "metadata-only", citation_key: "metadata-only", locator: { paragraph: 1 }, text: "Title: Metadata Only Authors: A View PDF", chars: 40 }] }), "utf-8");
    await fs.writeFile(path.join(root, "evidence", "active-validated-source-evidence.json"), JSON.stringify({ version: 1, entries: [] }), "utf-8");
    await writeCitedSourceUpgradePacket(root);
    const packet = JSON.parse(await fs.readFile(path.join(root, "reviews", "cited-source-upgrade-packet.json"), "utf-8"));
    expect(packet.addition_candidates).toEqual([]);
    expect(packet.candidate_capacity_pass).toBe(false);
  });
});
