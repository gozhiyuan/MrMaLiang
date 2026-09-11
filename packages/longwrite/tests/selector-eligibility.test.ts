import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { TargetRecord, writeTargets, readTargets } from "../src/lib/research/targets.js";
import {
  allocateTargetsToSections, eligibleTargets, pendingRetrievalTargets,
} from "../src/lib/research/reservation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

const target = (key: string, status: string, sourceId: string | null = "s1", section?: string) =>
  TargetRecord.parse({
    target_key: key, source_id: sourceId, status, reserved: true, history: [],
    ...(section ? { allocated_section: section } : {}),
  });

describe("selector eligibility", () => {
  it("stops reserving screening capacity for an already cited target", () => {
    const eligible = eligibleTargets([target("landmark:a", "cited")], "semantic_screen");
    // A cited target has finished the pipeline; holding a slot starves the
    // targets that still need one.
    expect(eligible).toEqual([]);
  });

  it("reserves a screening slot for an identity-verified target", () => {
    expect(eligibleTargets([target("landmark:a", "identity_verified")], "semantic_screen")).toHaveLength(1);
  });

  it("does not seed evidence extraction with a target that has no full text", () => {
    expect(eligibleTargets([target("landmark:a", "identity_verified")], "source_evidence")).toEqual([]);
    expect(eligibleTargets([target("landmark:a", "fulltext_ingested")], "source_evidence")).toHaveLength(1);
  });

  it("does not reserve full-text capacity for a target whose full text is unavailable", () => {
    expect(eligibleTargets([target("landmark:a", "fulltext_unavailable")], "fulltext_ingest")).toEqual([]);
  });

  it("proposes a target only to the section it was allocated to", () => {
    const targets = [
      target("landmark:a", "evidence_validated", "s1", "section-03"),
      target("landmark:b", "evidence_validated", "s2", "section-06"),
    ];
    // Proposing every landmark to every section is what made one section's
    // packet infeasible because of another section's landmarks.
    expect(eligibleTargets(targets, "section_allocation", "section-03").map((t) => t.target_key))
      .toEqual(["landmark:a"]);
  });

  it("reserves no section slot for an unallocated target", () => {
    expect(eligibleTargets([target("landmark:a", "evidence_validated")], "section_allocation", "section-03"))
      .toEqual([]);
  });

  it("surfaces unresolved targets for retrieval rather than dropping them", () => {
    // A retrieval_pending target has no source_id, so an id-based filter loses
    // it silently — the exact disappearance this ledger exists to prevent.
    const pending = pendingRetrievalTargets([target("landmark:a", "retrieval_pending", null)]);
    expect(pending.map((t) => t.target_key)).toEqual(["landmark:a"]);
  });

  it("excludes a target with a recorded exclusion from every selector", () => {
    const excluded = TargetRecord.parse({
      target_key: "landmark:a", source_id: "s1", status: "retrieved", reserved: true, history: [],
      exclusion: { reason: "fulltext_unavailable", detail: "paywalled", at: new Date().toISOString() },
    });
    for (const selector of ["semantic_screen", "source_evidence", "fulltext_ingest", "section_allocation"] as const) {
      expect(eligibleTargets([excluded], selector), selector).toEqual([]);
    }
  });
});

describe("selector return contracts", () => {
  async function baseWorkspace(): Promise<string> {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-shape-"));
    roots.push(ws);
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "seed", topic: "t", taxonomy: [] },
    }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
      JSON.stringify({ id: "s1", citation_depth: "A", title: "One", abstract: "x", venue: "V",
                       quality_score: 90, year: 2025, topics: [] }), "utf-8");
    return ws;
  }

  it("preserves ingestFulltext's results field", async () => {
    const { ingestFulltext } = await import("../src/lib/research/fulltext.js");
    const result = await ingestFulltext(await baseWorkspace());
    // Standardizing to { selected, written } would have broken every caller.
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.written)).toBe(true);
    expect(Array.isArray(result.selected)).toBe(true);
  });

  it("preserves allocateSectionEvidence's section summary", async () => {
    const { allocateSectionEvidence } = await import("../src/lib/research/evidence.js");
    const ws = await baseWorkspace();
    await fs.writeFile(path.join(ws, "outline.json"),
      JSON.stringify({ version: 1, sections: [{ id: "section-01", title: "One", sourceIds: [] }] }), "utf-8");
    const result = await allocateSectionEvidence(ws);
    expect(typeof result.sections).toBe("number");
    expect(Array.isArray(result.packets)).toBe(true);
    expect(typeof result.coveragePath).toBe("string");
    expect(Array.isArray(result.selected)).toBe(true);
  });

  it("keeps one section's landmarks out of another section's packet", async () => {
    const { allocateSectionEvidence } = await import("../src/lib/research/evidence.js");
    const ws = await baseWorkspace();
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), [
      { id: "s1", citation_depth: "A", title: "One", abstract: "x", venue: "V", quality_score: 90, year: 2025, topics: [] },
      { id: "s2", citation_depth: "A", title: "Two", abstract: "y", venue: "V", quality_score: 80, year: 2025, topics: [] },
    ].map((row) => JSON.stringify(row)).join("\n"), "utf-8");
    await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({
      version: 1,
      sections: [{ id: "section-03", title: "Three", sourceIds: [] }, { id: "section-06", title: "Six", sourceIds: [] }],
    }), "utf-8");
    await writeTargets(ws, [
      target("landmark:a", "evidence_validated", "s1", "section-03"),
      target("landmark:b", "evidence_validated", "s2", "section-06"),
    ]);
    const result = await allocateSectionEvidence(ws);
    expect(result.selected.sort()).toEqual(["s1", "s2"]);
    // Both were allocated, and neither disappeared: the accounting invariant
    // holds because each was reserved for its own section only.
    expect((await readTargets(ws)).every((record) => record.exclusion === undefined)).toBe(true);
  });
});

describe("allocating targets to sections", () => {

  async function ledgerWorkspace(records: unknown[]): Promise<string> {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-alloc-"));
    roots.push(ws);
    await writeTargets(ws, records as never);
    return ws;
  }

  it("prefers the section the outline already names", async () => {
    const ws = await ledgerWorkspace([target("landmark:a", "evidence_validated", "s1")]);
    await allocateTargetsToSections(ws, [
      { id: "section-01", sourceIds: [] }, { id: "section-02", sourceIds: ["s1"] },
    ]);
    expect((await readTargets(ws))[0].allocated_section).toBe("section-02");
  });

  it("labels a distributed allocation as a spread, not a judgment", async () => {
    const ws = await ledgerWorkspace([target("landmark:a", "evidence_validated", "s1")]);
    await allocateTargetsToSections(ws, [{ id: "section-01", sourceIds: [] }]);
    const record = (await readTargets(ws))[0];
    expect(record.allocated_section).toBe("section-01");
    expect(record.history.at(-1)?.detail).toMatch(/stable key order/);
  });

  it("is idempotent, so a rerun cannot shuffle a packet's sources", async () => {
    const ws = await ledgerWorkspace([
      target("landmark:a", "evidence_validated", "s1"),
      target("landmark:b", "evidence_validated", "s2"),
    ]);
    const sections = [{ id: "section-01", sourceIds: [] }, { id: "section-02", sourceIds: [] }];
    await allocateTargetsToSections(ws, sections);
    const first = (await readTargets(ws)).map((r) => `${r.target_key}:${r.allocated_section}`);
    await allocateTargetsToSections(ws, sections);
    expect((await readTargets(ws)).map((r) => `${r.target_key}:${r.allocated_section}`)).toEqual(first);
  });

  it("leaves an excluded or unvalidated target unallocated", async () => {
    const ws = await ledgerWorkspace([
      target("landmark:a", "retrieved", "s1"),
      TargetRecord.parse({
        target_key: "landmark:b", source_id: "s2", status: "evidence_validated", reserved: true,
        history: [], exclusion: { reason: "policy_rejection", detail: "out of scope", at: new Date().toISOString() },
      }),
    ]);
    await allocateTargetsToSections(ws, [{ id: "section-01", sourceIds: [] }]);
    for (const record of await readTargets(ws)) expect(record.allocated_section).toBeUndefined();
  });
});
