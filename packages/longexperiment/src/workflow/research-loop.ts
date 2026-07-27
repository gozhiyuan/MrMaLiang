import type { ExperimentConfig } from "../lib/schema.js";

/**
 * Compile the generalized search into a MalaClaw bounded loop (LE-4.3).
 *
 * The search is dynamic in content but static in shape: the engine never
 * mutates its own graph. A round proposes, the engine validates before
 * spending, candidates fan out through a real foreach, every candidate is
 * audited, and one deterministic promote stage decides what survives and
 * whether to continue. That ordering is the durability contract — an agent
 * cannot reach compute without passing validation, and cannot certify itself.
 */
export function researchLoopStage(
  config: ExperimentConfig,
  longexperimentCommand: (args: string[]) => { cmd: string; args: string[] },
  candidateExecution: Record<string, unknown>,
): Record<string, unknown> {
  const research = config.research;
  if (!research) throw new Error("the research loop cannot be compiled without a research: policy");
  return {
    type: "loop",
    id: "research_loop",
    title: "Bounded champion/candidate search",
    max_rounds: research.max_rounds,
    // The engine reads reports/metrics.json, which only the promote stage
    // writes. Exhaustion succeeds: a search that runs out of budget still has
    // a certified champion, which is a real result, not a failure.
    stop_when: "research_stop >= 1",
    on_exhaustion: "succeed",
    stages: [
      {
        id: "propose", title: "Propose and critique candidate experiments", owner: "experiment-lead",
        inputs: ["experiment.yaml", "runs/research-state.json", "runs/lineage.json"],
        optional_inputs: ["runs/dead-ends.json", "agent/literature-context.json"],
        skills: ["experiment.yaml", "runs/lineage.json", "runs/dead-ends.json"],
        instructions: [
          "Write ONLY runs/active-round/proposals.raw.json as {version:1,proposals:[...],critiques:[...]}.",
          "Each proposal is {version:1,id,author_id,parent_champion_id,hypothesis_family,mechanism,prediction,falsification,requested_change,changed_paths:[...],estimated_cost:{trials,gpu_hours,wall_minutes}}. id is lowercase [a-z][a-z0-9_-]*; mechanism, prediction, falsification and requested_change are each at least 12 characters.",
          "Each critique is {version:1,proposal_id,author_id,verdict,findings:[...]} with verdict accept|revise|reject and at least one finding of 8+ characters. Every proposal needs at least one critique whose author_id differs from its own, or the round is rejected before any compute.",
          "Give each proposal a DISTINCT hypothesis_family. Two proposals sharing a family and a changed path are treated as duplicates and only the first survives.",
          "Do not repeat a hypothesis family recorded in runs/dead-ends.json unless the stated reopening condition now holds. Do not request changes outside the configured mutable paths, and never report a measurement here.",
        ],
        outputs: ["runs/active-round/proposals.raw.json"], validators: ["required_output_exists"], retry: { max_attempts: 2 },
      },
      {
        id: "validate_plan", title: "Validate proposals before any compute", owner: "result-auditor",
        inputs: ["runs/active-round/proposals.raw.json", "experiment.yaml", "runs/research-state.json"],
        outputs: ["runs/active-round/candidates.json"],
        runtime: "script", command: longexperimentCommand(["stage", "validate-round-plan", "."]), validators: ["required_output_exists"],
        instructions: ["Reject duplicates, uncritiqued proposals, and mutation-policy violations before a single GPU-second is spent."],
      },
      {
        id: "materialize_candidates", title: "Branch each candidate from the champion commit", owner: "methodologist",
        inputs: ["runs/active-round/candidates.json", "inputs/locks.json", "runs/lineage.json"],
        outputs: ["worktrees/manifest.json"],
        runtime: "script", command: longexperimentCommand(["stage", "materialize-candidates", "."]), validators: ["required_output_exists"],
        instructions: ["Every candidate starts from the same immutable parent commit. Completed candidate branches are never rebased or reset."],
      },
      {
        type: "foreach", id: "execute_candidates", title: "Execute and audit each candidate",
        foreach: "runs/active-round/candidates.items", item_name: "candidate",
        max_parallel: config.execution.max_parallel_trials,
        steps: [
          {
            id: "implement", owner: "methodologist",
            inputs: ["runs/active-round/candidates.json", "worktrees/manifest.json"],
            skills: ["runs/active-round/candidates.json"],
            instructions: [
              "Implement the proposal for candidate {{candidate.id}} by editing files under worktrees/{{candidate.id}}/ ONLY. Its requested_change and changed_paths are in runs/active-round/candidates.json.",
              "Change only the paths that candidate declared, which the mutation policy already restricted. Never touch the evaluator or any protected path — the next stage diffs your work and rejects the candidate if you did.",
              "Make a real, minimal change that could plausibly move the primary metric. Do not edit the evaluator to change the score, do not write results, and do not report a measurement.",
            ],
            // No declared output: the real product is an edit inside the
            // worktree, whose path is the candidate's own declared change. A
            // marker file would itself be an out-of-policy path that the very
            // next stage rejects. `verify` is the gate — an agent that edited
            // nothing fails there with an explicit reason.
            retry: { max_attempts: 2 },
          },
          {
            id: "verify", owner: "result-auditor",
            inputs: ["worktrees/manifest.json"],
            outputs: ["results/studies/{{candidate.id}}/candidate-commit.json"],
            runtime: "script", command: longexperimentCommand(["stage", "verify-candidate", ".", "{{candidate.id}}"]),
            validators: ["required_output_exists"],
            instructions: ["A candidate becomes evidence only as an immutable commit that respected the mutation policy. An empty or out-of-policy diff is rejected before any compute is spent."],
          },
          {
            id: "execute", owner: "methodologist",
            inputs: ["worktrees/manifest.json", "inputs/locks.json"],
            outputs: ["results/studies/{{candidate.id}}/raw-results.json", "logs/studies/{{candidate.id}}/runner.log"],
            validators: ["required_output_exists"], ...candidateExecution,
          },
          {
            id: "audit", owner: "result-auditor",
            inputs: ["results/studies/{{candidate.id}}/raw-results.json", "inputs/locks.json"],
            outputs: ["results/studies/{{candidate.id}}/audit.json"],
            runtime: "script", command: longexperimentCommand(["stage", "audit-candidate", ".", "{{candidate.id}}"]),
            validators: ["required_output_exists"],
            instructions: ["Record a crash as durable evidence rather than failing the round; promotion treats an unaudited candidate as a dead end."],
          },
        ],
      },
      {
        id: "promote", title: "Promote a champion and record dead ends", owner: "result-auditor",
        inputs: ["runs/active-round/candidates.json", "results/studies/*/audit.json", "experiment.yaml"],
        outputs: ["runs/lineage.json", "runs/research-state.json", "reports/metrics.json"],
        runtime: "script", command: longexperimentCommand(["stage", "promote-round", "."]), validators: ["required_output_exists"],
        instructions: ["This is the only writer of champion state. Promotion requires an audited improvement outside measured noise; everything else becomes a recorded dead end."],
      },
    ],
  };
}
