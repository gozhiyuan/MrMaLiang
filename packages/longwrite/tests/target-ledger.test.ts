import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TARGET_STATUSES, EXCLUSION_REASONS, TargetRecord,
  readTargets, writeTargets, advance, reconcileLandmarkTargets,
} from "../src/lib/research/targets.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function landmarkWorkspace(candidates: unknown[], sources: unknown[]): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-targets-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "research"), { recursive: true });
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "research", "landmark-candidates.json"),
    JSON.stringify({ version: 1, candidates }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("target ledger", () => {
  it("covers the whole pipeline from retrieval to citation", () => {
    for (const status of ["retrieval_pending", "retrieved", "identity_verified",
      "fulltext_ingested", "fulltext_unavailable", "evidence_validated",
      "evidence_insufficient", "allocated", "cited"]) {
      expect(TARGET_STATUSES).toContain(status);
    }
  });

  it("distinguishes why a target left the pipeline", () => {
    // "Search failed", "full text unavailable" and "dropped by ranking" are
    // three different failures; without typed reasons they are one blank.
    for (const reason of ["identity_conflict", "source_unavailable", "fulltext_unavailable",
      "insufficient_claim_bearing_evidence", "duplicate_canonical_target",
      "outside_revised_scope", "policy_rejection", "capacity_infeasible"]) {
      expect(EXCLUSION_REASONS).toContain(reason);
    }
  });

  it("rejects an exclusion without a typed reason", () => {
    expect(TargetRecord.safeParse({
      target_key: "landmark:bert", source_id: null, status: "retrieved", reserved: true,
      exclusion: { detail: "did not make the cut", at: new Date().toISOString() }, history: [],
    }).success).toBe(false);
  });

  it("records each transition in history rather than overwriting", () => {
    const record = TargetRecord.parse({
      target_key: "landmark:bert", source_id: "s1", status: "retrieved", reserved: true, history: [],
    });
    const next = advance(record, "identity_verified");
    expect(next.status).toBe("identity_verified");
    expect(next.history.map((entry) => entry.status)).toEqual(["retrieved"]);
  });

  it("keys a target by its landmark key, not its source id", async () => {
    const ws = await landmarkWorkspace([{ name: "BERT", why_canonical: "x".repeat(25), confidence: "high" }], []);
    await reconcileLandmarkTargets(ws);
    expect((await readTargets(ws))[0].target_key).toBe("landmark:bert");
    expect((await readTargets(ws))[0].source_id).toBeNull();
  });

  it("fills in the source id when a target resolves later", async () => {
    const candidates = [{ name: "BERT", why_canonical: "x".repeat(25), confidence: "high" }];
    const ws = await landmarkWorkspace(candidates, []);
    await reconcileLandmarkTargets(ws);
    expect((await readTargets(ws))[0].status).toBe("retrieval_pending");

    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
      JSON.stringify({ id: "s1", title: "BERT", citation_depth: "A", identifiers: {} }), "utf-8");
    await reconcileLandmarkTargets(ws);
    const targets = await readTargets(ws);
    expect(targets).toHaveLength(1);
    expect(targets[0].source_id).toBe("s1");
    expect(targets[0].status).toBe("retrieved");
  });

  it("preserves a recorded exclusion instead of re-reserving over it", async () => {
    const ws = await landmarkWorkspace([{ name: "BERT", why_canonical: "x".repeat(25), confidence: "high" }], []);
    await reconcileLandmarkTargets(ws);
    const ledger = path.join(ws, "research", "target-ledger.json");
    const data = JSON.parse(await fs.readFile(ledger, "utf-8"));
    data.targets[0].exclusion = {
      reason: "fulltext_unavailable", detail: "paywalled", at: new Date().toISOString(),
    };
    await fs.writeFile(ledger, JSON.stringify(data), "utf-8");
    await reconcileLandmarkTargets(ws);
    // Re-reserving over an exclusion erases the typed reason a later round needs.
    expect((await readTargets(ws))[0].exclusion?.reason).toBe("fulltext_unavailable");
  });

  it("is idempotent across repeated reconciliation", async () => {
    const ws = await landmarkWorkspace([{ name: "BERT", why_canonical: "x".repeat(25), confidence: "high" }], []);
    await reconcileLandmarkTargets(ws);
    await reconcileLandmarkTargets(ws);
    expect(await readTargets(ws)).toHaveLength(1);
  });

  it("returns an empty ledger for a workspace that has none", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-targets-none-"));
    roots.push(ws);
    expect(await readTargets(ws)).toEqual([]);
  });

  it("round-trips a written ledger", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-targets-rt-"));
    roots.push(ws);
    const record = TargetRecord.parse({
      target_key: "landmark:bert", source_id: "s1", status: "cited", reserved: true, history: [],
    });
    await writeTargets(ws, [record]);
    expect(await readTargets(ws)).toEqual([record]);
  });
});
