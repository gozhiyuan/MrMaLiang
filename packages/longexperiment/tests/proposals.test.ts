import { describe, expect, it } from "vitest";
import { deduplicateProposal, validateProposalPacket, type ResearchProposal } from "../src/lib/proposals.js";

const proposal: ResearchProposal = { version: 1, id: "cache-layout", author_id: "researcher", parent_champion_id: "baseline", hypothesis_family: "cache locality", mechanism: "Reorder batches to improve contiguous cache access.", prediction: "Median latency will decrease by at least five percent.", falsification: "Reject if the paired heldout interval crosses zero.", requested_change: "Change only the batch ordering strategy.", changed_paths: ["src/batches.py"], estimated_cost: { trials: 4, gpu_hours: 0, wall_minutes: 20 } };
describe("proposal packet", () => {
  it("requires an independent critique and records deterministic novelty evidence", () => {
    expect(() => validateProposalPacket(proposal, [{ version: 1, proposal_id: "cache-layout", author_id: "researcher", verdict: "accept", findings: ["looks reasonable"] }])).toThrow(/non-author critique/);
    expect(validateProposalPacket(proposal, [{ version: 1, proposal_id: "cache-layout", author_id: "critic", verdict: "revise", findings: ["Measure memory pressure as a confounder."] }]).critiques).toHaveLength(1);
    expect(deduplicateProposal({ ...proposal, id: "cache-layout-copy" }, [proposal])).toMatchObject({ duplicate: true });
  });
});
