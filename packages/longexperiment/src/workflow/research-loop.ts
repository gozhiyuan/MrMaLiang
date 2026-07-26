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
          "Each proposal needs id, author_id, parent_champion_id, hypothesis_family, mechanism, prediction, falsification, requested_change, changed_paths, and estimated_cost. Every proposal needs at least one critique written by a different author_id.",
          "Do not repeat a hypothesis family recorded in runs/dead-ends.json unless the stated reopening condition now holds. Do not request changes outside the configured mutable paths, and never report a measurement here.",
        ],
        outputs: ["runs/active-round/proposals.raw.json"], validators: ["required_output_exists"], retry: { max_attempts: 2 },
      },
      {
        id: "validate_plan", title: "Validate proposals before any compute", owner: "result-auditor",
        inputs: ["runs/active-round/proposals.raw.json", "experiment.yaml", "runs/research-state.json"],
        outputs: ["runs/active-round/candidates.json", "runs/active-round/candidates.items.json"],
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
