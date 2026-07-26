/** Shared stage fragment used by generalized task profiles. Proposal creation,
 * independent critique, and deterministic deduplication all precede compute. */
export function proposalLoopStages(command: (args: string[]) => { cmd: string; args: string[] }): Array<Record<string, unknown>> {
  return [{
    type: "loop", id: "proposal_loop", title: "Propose and independently critique candidate changes", max_rounds: 2,
    stop_when: "proposal_ready >= 1", on_exhaustion: "fail",
    stages: [
      { id: "propose", owner: "experiment-lead", inputs: ["experiment.yaml", "runs/lineage.json"], outputs: ["runs/proposals.json"], validators: ["required_output_exists"] },
      { id: "critique", owner: "result-auditor", inputs: ["runs/proposals.json"], outputs: ["runs/proposal-critiques.json"], validators: ["required_output_exists"] },
      { id: "deduplicate", owner: "methodologist", inputs: ["runs/proposals.json", "runs/proposal-critiques.json"], outputs: ["runs/proposal-selection.json", "reports/metrics.json"], runtime: "script", command: command(["stage", "select-proposals", "."]), validators: ["required_output_exists"] },
    ],
  }];
}
