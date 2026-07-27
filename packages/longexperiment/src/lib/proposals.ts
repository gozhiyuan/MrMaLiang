import crypto from "node:crypto";
import { z } from "zod";

const ProposalId = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const ChangedPath = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "must be workspace-relative");

export const ResearchProposal = z.object({
  /** Defaulted: the authoring prompt states the field list, and a missing
   *  version must not discard an otherwise valid proposal. */
  version: z.literal(1).default(1),
  id: ProposalId,
  author_id: z.string().min(1),
  parent_champion_id: z.string().min(1),
  hypothesis_family: z.string().min(3),
  mechanism: z.string().min(12),
  prediction: z.string().min(12),
  falsification: z.string().min(12),
  requested_change: z.string().min(12),
  changed_paths: z.array(ChangedPath).min(1).max(80),
  estimated_cost: z.object({ trials: z.number().int().positive(), gpu_hours: z.number().nonnegative(), wall_minutes: z.number().positive() }).strict(),
}).strict();
export type ResearchProposal = z.infer<typeof ResearchProposal>;

export const ProposalCritique = z.object({
  version: z.literal(1).default(1),
  proposal_id: ProposalId,
  author_id: z.string().min(1),
  verdict: z.enum(["accept", "revise", "reject"]),
  findings: z.array(z.string().min(8)).min(1),
}).strict();
export type ProposalCritique = z.infer<typeof ProposalCritique>;

export type ProposalDeduplication = { duplicate: boolean; reasons: string[]; normalized_hash: string };

function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function normalizedProposal(proposal: ResearchProposal): string {
  return JSON.stringify({
    family: normalize(proposal.hypothesis_family), mechanism: normalize(proposal.mechanism), prediction: normalize(proposal.prediction),
    falsification: normalize(proposal.falsification), change: normalize(proposal.requested_change), paths: [...proposal.changed_paths].map(normalize).sort(),
  });
}
export function proposalHash(proposal: ResearchProposal): string { return crypto.createHash("sha256").update(normalizedProposal(proposal)).digest("hex"); }

/** Deterministic first-pass novelty gate. Embeddings can later add evidence,
 * but can never hide the exact/family/path audit record this returns. */
export function deduplicateProposal(proposal: ResearchProposal, existing: readonly ResearchProposal[]): ProposalDeduplication {
  const normalizedHash = proposalHash(proposal);
  const reasons: string[] = [];
  for (const candidate of existing) {
    if (proposalHash(candidate) === normalizedHash) reasons.push(`exact normalized duplicate of ${candidate.id}`);
    const sharedPaths = proposal.changed_paths.filter((item) => candidate.changed_paths.includes(item));
    if (normalize(candidate.hypothesis_family) === normalize(proposal.hypothesis_family) && sharedPaths.length > 0) {
      reasons.push(`same hypothesis family and changed paths as ${candidate.id}: ${sharedPaths.sort().join(", ")}`);
    }
  }
  return { duplicate: reasons.length > 0, reasons: [...new Set(reasons)], normalized_hash: normalizedHash };
}

/** Validate that a proposal is independently criticized before candidates exist. */
export function validateProposalPacket(proposalInput: unknown, critiquesInput: unknown[]): { proposal: ResearchProposal; critiques: ProposalCritique[] } {
  const proposal = ResearchProposal.parse(proposalInput);
  const critiques = critiquesInput.map((item) => ProposalCritique.parse(item));
  const independent = critiques.filter((critique) => critique.proposal_id === proposal.id && critique.author_id !== proposal.author_id);
  if (independent.length === 0) throw new Error(`proposal ${proposal.id} requires one non-author critique before candidate materialization`);
  return { proposal, critiques: independent };
}
