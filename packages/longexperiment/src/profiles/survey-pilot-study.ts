import { decidePromotion } from "../lib/promotion.js";
import type { ExperimentTaskProfile } from "../lib/task-profile.js";

export const surveyPilotStudyProfile: ExperimentTaskProfile = {
  id: "survey-pilot-study", version: 1, pilot: "survey_pilot_study",
  mutationPolicy: () => ({ mutable_paths: ["experiment/", "configs/"], protected_paths: ["evaluator/", "inputs/locks.json", ".git"], allowed_extensions: [".py", ".json", ".yaml", ".yml", ".toml", ".md"], max_files_changed: 30, max_total_bytes_changed: 400_000, dependency_policy: "allowlisted", allowed_dependencies: [] }),
  buildRound: ({ round, parentNodeId, maxRounds }) => ({ round_id: `round-${round}`, parent_node_id: parentNodeId, max_candidates: 3, stop_after_round: round >= maxRounds }),
  decidePromotion,
  shouldStop: ({ round, maxRounds }) => round >= maxRounds ? { stop: true, reason: "maximum rounds reached" } : { stop: false, reason: "approved pilot budget remains" },
};
