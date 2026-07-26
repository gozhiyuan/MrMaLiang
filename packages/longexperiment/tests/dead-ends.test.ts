import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordDeadEndEvidence } from "../src/lib/dead-ends.js";
const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });
describe("dead-end memory", () => {
  it("does not close a hypothesis family after one failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-dead-end-")); dirs.push(dir);
    const one = await recordDeadEndEvidence(dir, { candidate_node_id: "candidate-1", hypothesis_family: "cache locality", outcome: "discarded", reason: "paired result regressed heldout latency" });
    expect(one.closed_families).toEqual([]);
    const two = await recordDeadEndEvidence(dir, { candidate_node_id: "candidate-2", hypothesis_family: "cache locality", outcome: "discarded", reason: "second independent candidate also regressed" });
    expect(two.closed_families[0]).toMatchObject({ family: "cache locality", evidence_count: 2 });
  });
});
