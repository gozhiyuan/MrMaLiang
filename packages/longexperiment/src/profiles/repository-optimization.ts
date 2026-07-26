import { decidePromotion } from "../lib/promotion.js";
import type { ExperimentTaskProfile } from "../lib/task-profile.js";

export const repositoryOptimizationProfile: ExperimentTaskProfile = {
  id: "repository-optimization", version: 1, pilot: "repository_optimization",
  mutationPolicy: () => ({ mutable_paths: ["train.py"], protected_paths: ["prepare.py", "program.md", ".git"], allowed_extensions: [".py", ".json", ".toml", ".md"], max_files_changed: 12, max_total_bytes_changed: 200_000, dependency_policy: "frozen", allowed_dependencies: [] }),
  buildRound: ({ round, parentNodeId, maxRounds }) => ({ round_id: `round-${round}`, parent_node_id: parentNodeId, max_candidates: 4, stop_after_round: round >= maxRounds }),
  decidePromotion,
  shouldStop: ({ round, maxRounds, stagnationRounds }) => round >= maxRounds ? { stop: true, reason: "maximum rounds reached" } : stagnationRounds >= 2 ? { stop: true, reason: "two stagnant rounds" } : { stop: false, reason: "budget remains" },
};
