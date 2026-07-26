import { decidePromotion } from "../lib/promotion.js";
import type { ExperimentTaskProfile } from "../lib/task-profile.js";

export const paperReproductionProfile: ExperimentTaskProfile = {
  id: "paper-reproduction", version: 1, pilot: "paper_reproduction",
  mutationPolicy: () => ({ mutable_paths: ["reproduction/"], protected_paths: ["paper/anchors.json", "evaluator/", "inputs/locks.json", ".git"], allowed_extensions: [".py", ".json", ".yaml", ".yml", ".md"], max_files_changed: 30, max_total_bytes_changed: 400_000, dependency_policy: "allowlisted", allowed_dependencies: [] }),
  buildRound: ({ round, parentNodeId, maxRounds }) => ({ round_id: `round-${round}`, parent_node_id: parentNodeId, max_candidates: 2, stop_after_round: round >= maxRounds }),
  decidePromotion,
  shouldStop: ({ round, maxRounds }) => round >= maxRounds ? { stop: true, reason: "maximum rounds reached" } : { stop: false, reason: "claim matrix has remaining work" },
};
