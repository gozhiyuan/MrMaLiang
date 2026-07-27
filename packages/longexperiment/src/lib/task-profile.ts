import type { ExperimentConfig, ExperimentPilot } from "./schema.js";
import type { PromotionContext, PromotionDecision } from "./promotion.js";

/** Rules that bound what a candidate may mutate before compute is scheduled. */
export type MutationPolicy = {
  mutable_paths: string[];
  protected_paths: string[];
  allowed_extensions: string[];
  max_files_changed: number;
  max_total_bytes_changed: number;
  dependency_policy: "frozen" | "allowlisted" | "free";
  allowed_dependencies: string[];
};

export type ResearchRoundPlan = { round_id: string; parent_node_id: string; max_candidates: number; stop_after_round: boolean };
export type StopDecision = { stop: boolean; reason: string };

/**
 * Profile hooks define scientific policy, never workflow durability. MalaClaw
 * still owns execution/retry state; LongExperiment owns these constraints and
 * decisions which affect publication eligibility.
 */
export interface ExperimentTaskProfile {
  readonly id: string;
  readonly version: number;
  readonly pilot: ExperimentPilot;
  mutationPolicy(config: ExperimentConfig): MutationPolicy;
  buildRound(input: { round: number; parentNodeId: string; maxRounds: number }): ResearchRoundPlan;
  decidePromotion(context: PromotionContext): PromotionDecision;
  shouldStop(input: { round: number; maxRounds: number; stagnationRounds: number }): StopDecision;
}

export class TaskProfileRegistry {
  private readonly profiles = new Map<ExperimentPilot, ExperimentTaskProfile>();
  register(profile: ExperimentTaskProfile): void {
    if (this.profiles.has(profile.pilot)) throw new Error(`task profile already registered for ${profile.pilot}`);
    this.profiles.set(profile.pilot, profile);
  }
  resolve(config: ExperimentConfig): ExperimentTaskProfile {
    if (!config.pilot) throw new Error("experiment.pilot is required for generalized research loops; migrate the workspace explicitly");
    const profile = this.profiles.get(config.pilot);
    if (!profile) throw new Error(`no task profile registered for ${config.pilot}`);
    return profile;
  }
  ids(): ExperimentPilot[] { return [...this.profiles.keys()].sort() as ExperimentPilot[]; }
}
