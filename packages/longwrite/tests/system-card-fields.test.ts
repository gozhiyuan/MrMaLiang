import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SourceEvidencePackets, repairSourceEvidencePackets, SOURCE_EVIDENCE_CANDIDATES_PATH, SOURCE_EVIDENCE_PATH } from "../src/lib/research/semantic-screen.js";

describe("system-card fields on SourceEvidenceClaim", () => {
  it("accepts a claim with system-card status fields", () => {
    const parsed = SourceEvidencePackets.parse({
      version: 1,
      packets: [{
        source_id: "s1",
        recommended_depth: "A",
        claims: [{
          claim: "The system modifies its own agent code and evaluates the modification empirically.",
          supporting_excerpt: "the agent modifies its own scaffolding code and evaluates the change against a benchmark",
          locator: "p4",
          modified_object: "agent scaffolding code",
          proposer_or_improver: "the agent itself, via an LLM-generated patch",
          evaluation_mechanism: "benchmark suite execution",
          persistence_scope: "archived variant reused in later iterations",
          later_use: "demonstrated",
          cross_task_transfer: "not_reported",
          meta_improvement: "partial",
          human_oversight: "none described",
          sandbox_rollback_provenance: "archive keeps prior variants; no explicit rollback trigger",
          benchmarks: ["SWE-bench subset"],
        }],
      }],
    });
    expect(parsed.packets[0]!.claims[0]!.later_use).toBe("demonstrated");
  });

  it("still accepts a claim with none of the new optional fields (backward compatible)", () => {
    const parsed = SourceEvidencePackets.parse({
      version: 1,
      packets: [{
        source_id: "s1",
        recommended_depth: "B",
        claims: [{ claim: "A claim with only the original required fields present here.", supporting_excerpt: "an excerpt long enough to pass validation", locator: "p1" }],
      }],
    });
    expect(parsed.packets[0]!.claims[0]!.later_use).toBeUndefined();
  });

  it("rejects an invalid later_use value", () => {
    expect(() => SourceEvidencePackets.parse({
      version: 1,
      packets: [{
        source_id: "s1",
        recommended_depth: "A",
        claims: [{ claim: "A claim with an invalid status enum value set here.", supporting_excerpt: "an excerpt long enough to pass validation", locator: "p1", later_use: "sort_of" }],
      }],
    })).toThrow();
  });
});

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

async function buildWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "system-card-"));
  tempDirs.push(ws);
  await fs.mkdir(path.join(ws, "fulltext"), { recursive: true });
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "evidence"), { recursive: true });
  const fulltext = "The agent modifies its own scaffolding code and evaluates the change against a benchmark suite before promoting it.";
  await fs.writeFile(path.join(ws, "fulltext", "s1.txt"), fulltext);
  await fs.writeFile(path.join(ws, SOURCE_EVIDENCE_CANDIDATES_PATH), JSON.stringify({
    candidates: [{ id: "s1", title: "Example System", fulltext_path: "fulltext/s1.txt" }],
  }));
  await fs.writeFile(path.join(ws, "longwrite.yaml"), [
    "version: 1",
    "project:",
    "  id: t",
    "  artifact_type: research_paper",
    "  mode: auto_research_agentic",
  ].join("\n"));
  return ws;
}

it("rejects an A-depth packet whose claims record no system-improvement status field", async () => {
  const ws = await buildWorkspace();
  await fs.writeFile(path.join(ws, SOURCE_EVIDENCE_PATH), JSON.stringify({
    version: 1,
    packets: [{
      source_id: "s1",
      recommended_depth: "A",
      claims: [
        { claim: "The agent modifies its own scaffolding code before promotion.", supporting_excerpt: "modifies its own scaffolding code and evaluates the change", locator: "p1" },
        { claim: "The change is evaluated against a benchmark suite before use.", supporting_excerpt: "evaluates the change against a benchmark suite before promoting", locator: "p1" },
      ],
    }],
  }));
  await expect(repairSourceEvidencePackets(ws)).rejects.toThrow(/invalid source-evidence contract/);
  const report = await fs.readFile(path.join(ws, "reports", "source-evidence-repair.md"), "utf8");
  expect(report).toContain("later_use/cross_task_transfer/meta_improvement");
});

it("accepts an A-depth packet once every claim records a system-improvement status field", async () => {
  const ws = await buildWorkspace();
  await fs.writeFile(path.join(ws, SOURCE_EVIDENCE_PATH), JSON.stringify({
    version: 1,
    packets: [{
      source_id: "s1",
      recommended_depth: "A",
      claims: [
        { claim: "The agent modifies its own scaffolding code before promotion.", supporting_excerpt: "modifies its own scaffolding code and evaluates the change", locator: "p1", later_use: "demonstrated" },
        { claim: "The change is evaluated against a benchmark suite before use.", supporting_excerpt: "evaluates the change against a benchmark suite before promoting", locator: "p1", later_use: "not_reported" },
      ],
    }],
  }));
  await expect(repairSourceEvidencePackets(ws)).resolves.toMatchObject({ normalized: false });
});
